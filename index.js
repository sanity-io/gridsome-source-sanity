const {
  startCase
} = require('lodash')
const {
  valueFromASTUntyped
} = require('graphql')
const axios = require('axios')
const pumpIt = require('pump')
const split = require('split2')
const through = require('through2')
const sanityClient = require('@sanity/client')
const addFieldPrefixes = require('./addFieldPrefixes')
const getRemoteGraphQLSchema = require('./remoteGraphQLSchema')
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

    const {
      projectId,
      dataset,
      token,
      useCdn
    } = options

    this.client = sanityClient({
      projectId,
      dataset,
      token,
      useCdn
    })

    api.loadSource(async store => {
      this.graphqlTypes = await getRemoteGraphQLSchema(this.client)
      await this.getDocuments(store)
    })
  }

  prepareContentType(store, typeName, docExample) {
    const contentType = store.addContentType({
      typeName,
    })

    const graphqlName = getTypeName(docExample._type)
    const graphqlType = this.graphqlTypes.find(item => item.name.value === graphqlName)
    if (!graphqlType) {
      console.warn(`Could not find GraphQL type for type ${typeName}`)
      return
    }

    graphqlType.fields.map(getJsonAliasDirective).filter(Boolean).forEach(jsonField => {
      contentType.addSchemaField(`_raw${ucFirst(jsonField.aliasFor)}`, ({
        graphql
      }) => ({
        type: graphql.GraphQLJSON,
        resolve: doc => addFieldPrefixes(doc.fields[jsonField.aliasFor])
      }))
    })
  }

  async getDocuments(store) {
    const {
      dataset,
      overlayDrafts,
      watchMode,
      token
    } = this.client.config()

    const url = this.client.getUrl(`/data/export/${dataset}`)
    const inputStream = await getDocumentStream(url, token)
    const typesSeen = new Set()

    await pump([
      inputStream,
      split(JSON.parse),
      rejectOnApiError(),
      removeSystemDocuments(),
      through.obj((doc, enc, callback) => {
        const {
          _id,
          _createdAt,
          _updatedAt,
          _type
        } = doc

        const typeName = store.makeTypeName(_type)
        if (!typesSeen.has(typeName)) {
          this.prepareContentType(store, typeName, doc)
          typesSeen.add(typeName)
        }

        const collection = store.getContentType(typeName)
        const fields = {
          ...doc,
          date: _createdAt,
          updatedAt: _updatedAt
        }

        collection.addNode({
          id: _id,
          slug: doc.title,
          fields
        })

        callback()
      }),
    ])
  }
}

function ucFirst(str) {
  return (str[0] || '').toUpperCase() + str.slice(1)
}

function getTypeName(str) {
  return startCase(str).replace(/\s+/g, '')
}

function rejectOnApiError() {
  return through.obj(function (sanityDoc, string, callback) {
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
  return through.obj(function (doc, string, callback) {
    if (doc && doc._id && doc._id.startsWith('_.')) {
      return callback()
    }

    return callback(null, doc)
  })
}

function getDocumentStream(url, token) {
  const auth = token ? {
    Authorization: `Bearer ${token}`
  } : {}
  const userAgent = {
    'User-Agent': 'gridsome-source-sanity'
  }
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
    aliasFor: valueFromASTUntyped(
      alias.arguments.find(arg => arg.name.value === 'for').value
    )
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

module.exports = SanitySource
