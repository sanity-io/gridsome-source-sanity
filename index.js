const {startCase} = require('lodash')
const {valueFromASTUntyped} = require('graphql')
const axios = require('axios')
const pumpIt = require('pump')
const split = require('split2')
const through = require('through2')
const sanityClient = require('@sanity/client')
const addFieldPrefixes = require('./addFieldPrefixes')
const getRemoteGraphQLSchema = require('./remoteGraphQLSchema')

const basicTypes = ['String', 'Int', 'Float', 'Boolean', 'ID']

class SanitySource {
  static defaultOptions() {
    return {
      typeName: 'Sanity',
      projectId: '',
      datasetname: '',
      token: '',
      useCdn: false,
      overlayDrafts: '',
      watchMode: false,
      routes: {}
    }
  }

  constructor(api, options) {
    this.options = options
    this.store = api.store
    this.typesIndex = {}

    const {projectId, dataset, token, useCdn} = options

    this.client = sanityClient({
      projectId,
      dataset,
      token,
      useCdn
    })

    api.loadSource(async store => {
      this.graphqlTypes = await getRemoteGraphQLSchema(this.client)
      await this.prepareContentTypes(store)
      await this.getDocuments(store)
    })
  }

  prepareContentTypes(store) {
    this.graphqlTypes.forEach(type => this.prepareContentType(type, store))
  }

  // eslint-disable-next-line class-methods-use-this
  prepareContentType(graphqlType, store) {
    const graphqlName = graphqlType.name.value
    const typeName = normalizeTypeName(store.makeTypeName(graphqlName))
    const contentType = store.addContentType({typeName})

    // Add JSON aliases
    graphqlType.fields
      .map(getJsonAliasDirective)
      .filter(Boolean)
      .forEach(jsonField =>
        contentType.addSchemaField(`_raw${ucFirst(jsonField.aliasFor)}`, ({graphql}) => ({
          type: graphql.GraphQLJSON,
          resolve: doc => addFieldPrefixes(doc.fields[jsonField.aliasFor])
        }))
      )

    // Add regular, non-primitive fields
    graphqlType.fields
      .filter(field => !getJsonAliasDirective(field))
      .map(field => ({...field, unwrappedType: unwrapType(field.type)}))
      .forEach(field => {
        const unwrappedName = field.unwrappedType.name.value
        const unwrapped = makeNullable(field)
        const isList = unwrapped.kind === 'ListType'

        if (basicTypes.includes(unwrappedName)) {
          return contentType.addSchemaField(field.name.value, ({graphql}) => ({
            type: isList
              ? graphql.GraphQLList(graphql[`GraphQL${unwrappedName}`])
              : graphql[`GraphQL${unwrappedName}`]
          }))
        }

        if (unwrappedName === 'DateTime') {
          // :murgh: Gridsome doesn't seem to expose the date type?
          return contentType.addSchemaField(field.name.value, ({graphql}) => ({
            type: isList ? graphql.GraphQLList(graphql.GraphQLString) : graphql.GraphQLString
          }))
        }

        return contentType.addSchemaField(field.name.value, ({graphql, nodeTypes}) => {
          const name = normalizeTypeName(store.makeTypeName(unwrappedName))
          const resolve = inp => ({id: 'abc123', alt: 'foo'})
          return {type: isList ? graphql.GraphQLList(nodeTypes[name]) : nodeTypes[name], resolve}
        })
      })
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
      through.obj((doc, enc, callback) => {
        const {_id, _createdAt, _updatedAt, _type} = doc
        const gqlTypeName = getGraphQLTypeName(_type)
        const typeName = normalizeTypeName(store.makeTypeName(gqlTypeName))
        const collection = store.getContentType(typeName)
        collection.addNode({
          id: _id,
          slug: doc.title,
          fields: {...doc, date: _createdAt, updatedAt: _updatedAt}
        })

        callback()
      })
    ])
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

module.exports = SanitySource
