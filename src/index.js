const crypto = require('crypto')
const {startCase} = require('lodash')
const {valueFromASTUntyped} = require('graphql')
const axios = require('axios')
const pumpIt = require('pump')
const split = require('split2')
const through = require('through2')
const oneline = require('oneline')
const sanityClient = require('@sanity/client')
const getRemoteGraphQLSchema = require('./remoteGraphQLSchema')

const gqlScalarTypes = ['String', 'Int', 'Float', 'Boolean', 'ID']

class SanitySource {
  static defaultOptions() {
    return {
      typeName: 'Sanity',
      projectId: '',
      dataset: '',
      token: '',
      useCdn: false,
      overlayDrafts: false,
      watchMode: false,
      routes: {}
    }
  }

  constructor(api, options) {
    this.options = options
    this.store = api.store
    this.typesIndex = {}

    const {projectId, dataset, token, useCdn} = options

    this.uidPrefix = sha1([projectId, dataset, token].join('-'))
    this.client = sanityClient({
      apiVersion: '1',
      projectId,
      dataset,
      token,
      useCdn
    })

    api.loadSource(async store => {
      const remoteSchema = await getRemoteGraphQLSchema(this.client)
      await this.declareContentTypes(store, remoteSchema)
      await this.getDocuments(store)
    })
  }

  declareContentTypes(store, remoteSchema) {
    const {addSchemaTypes} = store
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
    const {makeTypeName, addContentType, schema} = store
    const {createObjectType} = schema
    const graphqlName = graphqlType.name.value
    const typeName = normalizeTypeName(makeTypeName(graphqlName))
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

        // Remap DateTime to Date
        if (unwrappedName === 'DateTime') {
          fields[field.name.value] = {
            type: isList ? '[Date]' : 'Date'
          }
          return
        }

        // Maps to one of our own types
        const targetName = normalizeTypeName(makeTypeName(unwrappedName))
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
          resolve: source => source[jsonField.aliasFor]
        }
      })

    if (isDocumentType) {
      addContentType(typeName)
    }

    return createObjectType({
      name: typeName,
      interfaces: isDocumentType ? ['Node'] : [],
      fields
    })
  }

  // eslint-disable-next-line class-methods-use-this
  createUnionType(graphqlType, store, gqlSchema) {
    const {makeTypeName, schema} = store
    const {createUnionType} = schema
    const graphqlName = graphqlType.name.value
    const typeName = normalizeTypeName(makeTypeName(graphqlName))
    const allDocuments = graphqlType.types.every(type => {
      const target = gqlSchema.definitions.find(
        def => def.name && def.name.value === type.name.value
      )
      return target && target.interfaces.some(iface => iface.name.value === 'Document')
    })

    const targetTypeNames = graphqlType.types.map(type =>
      normalizeTypeName(makeTypeName(type.name.value))
    )

    return createUnionType({
      name: typeName,
      interfaces: allDocuments ? ['Node'] : [],
      types: targetTypeNames,
      resolveType: (data, context, info) => {
        const target = data._type && normalizeTypeName(makeTypeName(data._type))
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
    const {dataset, overlayDrafts, watchMode, token} = this.client.config()

    const url = this.client.getUrl(`/data/export/${dataset}`)
    const inputStream = await getDocumentStream(url, token)

    await pump([
      inputStream,
      split(JSON.parse),
      rejectOnApiError(),
      removeSystemDocuments(),
      this.addDocumentsToCollection(store)
    ])
  }

  addDocumentToCollection(doc, store) {
    const {makeTypeName, getContentType} = store
    const {_id, _type} = doc
    const gqlTypeName = getGraphQLTypeName(_type)
    const typeName = normalizeTypeName(makeTypeName(gqlTypeName))
    const collection = getContentType(typeName)

    if (!collection) {
      console.warn(
        oneline`
        [warn] Document with ID "%s" has type "%s", which is not declared
        as a document type in the GraphQL schema. Have you remembered to
        run \`sanity graphql deploy\` lately? Skipping document.`,
        _id,
        _type
      )
      return
    }

    collection.addNode({
      $uid: this.getUid(_id),
      id: _id,
      ...doc
    })
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

function getGraphQLTypeName(str) {
  return startCase(str).replace(/\s+/g, '')
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

function getDocumentStream(url, token) {
  const auth = token ? {Authorization: `Bearer ${token}`} : {}
  const userAgent = {'User-Agent': 'gridsome-source-sanity'}
  const headers = {
    ...userAgent,
    ...auth
  }

  return axios({
    method: 'get',
    responseType: 'stream',
    url,
    headers
  }).then(res => res.data)
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

function normalizeTypeName(typeName) {
  return typeName.replace(/^SanitySanity/, 'Sanity')
}

function sha1(value) {
  return crypto
    .createHash('sha1')
    .update(value)
    .digest('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 10)
}

module.exports = SanitySource
