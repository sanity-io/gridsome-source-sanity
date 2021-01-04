/* eslint-disable no-console */
const crypto = require('crypto')
const {valueFromASTUntyped} = require('graphql')
const axios = require('axios')
const pumpIt = require('pump')
const split = require('split2')
const through = require('through2')
const oneline = require('oneline')
const {startCase} = require('lodash')
const sanityClient = require('@sanity/client')
const {version} = require('../package.json')
const resolveReferences = require('./resolveReferences')
const handleListenerEvent = require('./handleListenerEvent')
const getRemoteGraphQLSchema = require('./remoteGraphQLSchema')
const {extractDrafts, removeDrafts, unprefixDraftId} = require('./draftHandlers')

const gqlScalarTypes = ['String', 'Int', 'Float', 'Boolean', 'ID']

class SanitySource {
  static defaultOptions() {
    return {
      typeName: 'Sanity',
      projectId: '',
      dataset: '',
      token: '',
      graphqlTag: 'default',
      overlayDrafts: false,
      watchMode: false
    }
  }

  constructor(api, options) {
    this.options = options

    const {projectId, dataset, token, overlayDrafts, graphqlTag} = options

    if (overlayDrafts && !token) {
      console.warn('[sanity] `overlayDrafts` set to true, but no `token` specified!')
    }

    // We're passing these methods around to helpers, so bind them for correct scoping
    this.getUid = this.getUid.bind(this)
    this.getCollectionForType = this.getCollectionForType.bind(this)
    this.addDocumentToCollection = this.addDocumentToCollection.bind(this)

    this.uidPrefix = sha1([projectId, dataset, token].join('-'))
    this.client = sanityClient({
      apiVersion: '1',
      useCdn: false,
      projectId,
      dataset,
      token
    })

    api.loadSource(async store => {
      const remoteSchema = await getRemoteGraphQLSchema(this.client, graphqlTag)
      await this.declareContentTypes(store, remoteSchema)
      await this.getDocuments(store)
    })

    api.createSchema(({ addSchemaTypes }) => {
      addSchemaTypes(`
        type SanityDocument implements Node @infer {
          id: ID!
        }
      `)
    })
  }

  makeTypeName(originalName) {
    return `${this.options.typeName}${originalName}`.replace(/^SanitySanity/, 'Sanity')
  }

  declareContentTypes(store, remoteSchema) {
    const {addSchemaTypes} = store

    addSchemaTypes(`
      input SanityResolveReferencesConfiguration {
        maxDepth: Int!
      }
    `)

    addSchemaTypes(
      remoteSchema.definitions
        .filter(def => ['ObjectTypeDefinition', 'UnionTypeDefinition'].includes(def.kind))
        .map(def =>
          def.kind === 'ObjectTypeDefinition'
            ? this.createObjectType(def, store, remoteSchema)
            : this.createUnionType(def, store, remoteSchema)
        )
    )
  }

  // eslint-disable-next-line class-methods-use-this
  createObjectType(graphqlType, store) {
    const {overlayDrafts} = this.options
    const {addCollection, schema} = store
    const {createObjectType} = schema
    const graphqlName = graphqlType.name.value
    const typeName = this.makeTypeName(graphqlName)
    const isDocumentType = graphqlType.interfaces.some(iface => iface.name.value === 'Document')

    const fields = isDocumentType ? {id: {type: 'ID!'}} : {}

    // Regular fields
    graphqlType.fields
      .filter(field => !getJsonAliasDirective(field))
      .map(field => ({...field, unwrappedType: unwrapType(field.type)}))
      .forEach(field => {
        const unwrappedName = field.unwrappedType.name.value
        const unwrapped = makeNullable(field)
        const isList = field.type.kind === 'ListType' || unwrapped.kind === 'ListType'

        // Scalar type?
        if (gqlScalarTypes.includes(unwrappedName)) {
          fields[field.name.value] = {
            // Custom resolver not necessary since it's 1:1 with field name and primitive type
            type: isList ? `[${unwrappedName}]` : unwrappedName
          }
          return
        }

        // Remap Date/DateTime to Date
        if (unwrappedName === 'DateTime' || unwrappedName === 'Date') {
          fields[field.name.value] = {
            type: isList ? '[Date]' : 'Date'
          }
          return
        }

        // Maps to one of our own types
        const targetName = this.makeTypeName(unwrappedName)
        fields[field.name.value] = {
          type: isList ? `[${targetName}]` : targetName,
          resolve: (source, args, context) => {
            if (isList) {
              const items = source[field.name.value] || []
              return items && Array.isArray(items)
                ? items.map(item => this.maybeResolveReference(item, context.store))
                : []
            }

            return this.maybeResolveReference(source[field.name.value], context.store)
          }
        }
      })

    // JSON aliases
    graphqlType.fields
      .map(getJsonAliasDirective)
      .filter(Boolean)
      .forEach(jsonField => {
        fields[`_raw${ucFirst(jsonField.aliasFor)}`] = {
          type: 'JSON',
          args: {
            resolveReferences: {
              type: 'SanityResolveReferencesConfiguration'
            }
          },
          resolve: (source, args, context) => {
            const resolveContext = {store: context.store, getUid: this.getUid, overlayDrafts}
            const value = source[jsonField.aliasFor]
            return args.resolveReferences
              ? resolveReferences(value, 0, args.resolveReferences.maxDepth, resolveContext)
              : value
          }
        }
      })

    if (isDocumentType) {
      addCollection({
        typeName,
        dateField: '_createdAt'
      })
    }

    return createObjectType({
      name: typeName,
      interfaces: isDocumentType ? ['Node'] : [],
      fields
    })
  }

  // eslint-disable-next-line class-methods-use-this
  createUnionType(graphqlType, store, gqlSchema) {
    const {schema} = store
    const {createUnionType} = schema
    const graphqlName = graphqlType.name.value
    const typeName = this.makeTypeName(graphqlName)
    const allDocuments = graphqlType.types.every(type => {
      const target = gqlSchema.definitions.find(
        def => def.name && def.name.value === type.name.value
      )
      return target && target.interfaces.some(iface => iface.name.value === 'Document')
    })

    const targetTypeNames = graphqlType.types.map(type => this.makeTypeName(type.name.value))

    return createUnionType({
      name: typeName,
      interfaces: allDocuments ? ['Node'] : [],
      types: targetTypeNames,
      resolveType: (data, context, info) => {
        const gqlTypeName = data._type && getGraphQLTypeName(data._type)
        const target = gqlTypeName && this.makeTypeName(gqlTypeName)
        const type = target && info.schema.getType(target)
        return type || null
      }
    })
  }

  maybeResolveReference(item, store) {
    if (item && typeof item._ref === 'string') {
      return store.getNodeByUid(this.getUid(item._ref))
    }

    return item
  }

  async getDocuments(store) {
    const {getUid, addDocumentToCollection} = this
    const {overlayDrafts, watchMode} = this.options
    const {dataset, token} = this.client.config()

    const url = this.client.getUrl(`/data/export/${dataset}`)
    const inputStream = await getDocumentStream(url, token)

    // Mutated by overlayed drafts handling
    const drafts = []
    const published = new Map()

    await pump([
      inputStream,
      split(JSON.parse),
      rejectOnApiError(),
      overlayDrafts ? extractDrafts(drafts, published) : removeDrafts(),
      removeSystemDocuments(),
      this.addDocumentsToCollection(store)
    ])

    if (drafts.length > 0) {
      console.info('[sanity] Overlaying drafts')
      drafts.forEach(draft => this.addDocumentToCollection(draft, store))
    }

    if (watchMode) {
      console.info('[sanity] Watch mode enabled, starting a listener')

      const filters = ['!(_id in path("_.**"))']
      if (!overlayDrafts) {
        filters.push('!(_id in path("drafts.**"))')
      }

      const docs = {drafts, published}
      const {getCollectionForType} = this
      const options = {
        store,
        overlayDrafts,
        getUid,
        addDocumentToCollection,
        getCollectionForType
      }

      this.client.listen(`*[${filters.join(' && ')}]`).subscribe(event => {
        handleListenerEvent(event, options, docs)
      })
    }
  }

  // eslint-disable-next-line class-methods-use-this
  getCollectionForType(type, store) {
    const {getCollection} = store
    const gqlTypeName = getGraphQLTypeName(type)
    const typeName = this.makeTypeName(gqlTypeName)
    return getCollection(typeName)
  }

  addDocumentToCollection(doc, store) {
    const {overlayDrafts} = this.options
    const {_id, _type} = doc
    const id = overlayDrafts ? unprefixDraftId(_id) : _id
    const collection = this.getCollectionForType(_type, store)

    if (!collection) {
      console.warn(
        oneline`
        [sanity] Document with ID "%s" has type "%s", which is not declared
        as a document type in the GraphQL schema. Have you remembered to
        run \`sanity graphql deploy\` lately? Skipping document.`,
        _id,
        _type
      )
      return
    }

    // Gridsome overrides `node.id` with `node._id` if present.
    // This is scheduled for removal at 1.0, but for now we have to pass the non-draft
    // id to make sure we actually update the same node as we were expecting to.
    const newNode = {...doc, id, $uid: this.getUid(id), _id: id}
    const existingNode = collection.getNodeById(id)

    if (existingNode) {
      collection.updateNode(newNode)
    } else {
      collection.addNode(newNode)
    }
  }

  // eslint-disable-next-line class-methods-use-this
  addDocumentsToCollection(store) {
    return through.obj((doc, enc, callback) => {
      this.addDocumentToCollection(doc, store)
      callback()
    })
  }

  getUid(id) {
    return `${this.uidPrefix}-${id}`
  }
}

function ucFirst(str) {
  return (str[0] || '').toUpperCase() + str.slice(1)
}

function rejectOnApiError() {
  return through.obj(function(sanityDoc, string, callback) {
    const doc = sanityDoc
    if (doc._id && doc._type) {
      callback(null, doc)
      return
    }

    const error = sanityDoc
    if (error.statusCode && error.error) {
      callback(new Error(`${error.statusCode}: ${error.error}`))
      return
    }

    callback()
  })
}

function removeSystemDocuments() {
  return through.obj(function(doc, string, callback) {
    if (doc && doc._id && doc._id.startsWith('_.')) {
      return callback()
    }

    return callback(null, doc)
  })
}

async function getDocumentStream(url, token) {
  const auth = token ? {Authorization: `Bearer ${token}`} : {}
  const userAgent = {'User-Agent': `gridsome-source-sanity@${version}`}
  const headers = {
    ...userAgent,
    ...auth
  }

  try {
    const response = await axios({
      method: 'get',
      responseType: 'stream',
      maxRedirects: 0,
      url,
      headers
    })

    return response.data
  } catch (err) {
    if (err.response.status === 404) {
      err.message = `${err.message} - double-check project ID and dataset configuration`
    }

    throw err
  }
}

function getJsonAliasDirective(field) {
  const alias = field.directives.find(dir => dir.name.value === 'jsonAlias')
  if (!alias) {
    return null
  }

  return {
    aliasFor: valueFromASTUntyped(alias.arguments.find(arg => arg.name.value === 'for').value)
  }
}

function pump(streams) {
  return new Promise((resolve, reject) =>
    pumpIt(streams, err => {
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    })
  )
}

function unwrapType(typeNode) {
  if (['NonNullType', 'ListType'].includes(typeNode.kind)) {
    const wrappedType = typeNode
    return unwrapType(wrappedType.type)
  }

  return typeNode
}

function makeNullable(typeNode) {
  if (typeNode.kind === 'NonNullType') {
    return makeNullable(typeNode.type)
  } else if (typeNode.kind === 'ListType') {
    return {...typeNode, type: makeNullable(typeNode.type)}
  }

  return typeNode
}

function sha1(value) {
  return crypto
    .createHash('sha1')
    .update(value)
    .digest('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 10)
}

function getGraphQLTypeName(str) {
  return startCase(str).replace(/\s+/g, '')
}

module.exports = SanitySource
