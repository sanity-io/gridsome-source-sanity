console.log('hi!')
const axios = require('axios')
const pumpIt = require('pump')
const split = require('split2')
const through = require('through2')
const GraphQLJSON = require('graphql-type-json')
const sanityClient = require('@sanity/client')
class SanitySource {
  static defaultOptions () {
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

  constructor (api, options) {
    this.options = options
    this.store = api.store
    this.typesIndex = {}

    const { projectId, dataset, token, useCdn } = options
    this.client = sanityClient({ projectId, dataset, token, useCdn })

    api.loadSource(async store => {
      await this.getDocuments(store)
    })
  }
  rejectOnApiError () {
    return through.obj(function (sanityDoc, string, callback) {
      const doc = sanityDoc
      if (doc._id && doc._type) {
        callback(null, doc)
        return
      }

      const error = sanityDoc
      if (error.statusCode && error.error) {
        callback(new Error(`${error.statusCode}: ${error.error}`))
      }
    })
  }
  removeSystemDocuments () {
    return through.obj(function (doc, string, callback) {
      if (doc && doc._id && doc._id.startsWith('_.')) {
        return callback()
      }

      return callback(null, doc)
    })
  }

  getDocumentStream (url, token) {
    const auth = token ? { Authorization: `Bearer ${token}` } : {}
    const userAgent = { 'User-Agent': 'gridsome-source-sanity' }
    const headers = { ...userAgent, ...auth }

    return axios({
      method: 'get',
      responseType: 'stream',
      url,
      headers
    }).then(res => res.data)
  }

  async getDocuments (store) {
    const { dataset, overlayDrafts, watchMode, token } = this.client.config()
    const url = this.client.getUrl(`/data/export/${dataset}`)
    const inputStream = await this.getDocumentStream(url, token)
    await this.pump([
      inputStream,
      split(JSON.parse),
      this.rejectOnApiError(),
      this.removeSystemDocuments(),
      through.obj((doc, enc, callback) => {
        const { _id, _createdAt, _updatedAt, _type } = doc
        const typeName = store.makeTypeName(_type)
        const contentType = store.addContentType({
          typeName,
          // route: `${store.slugify(_type)}/:slug`
        })
        /* contentType.addSchemaField('_rawBody', ({graphql}) =>  ({
          type: graphql.GraphQLJSON,
          resolve(doc) {
            return doc.fields.body
          }
        })) */

        const collection = store.getContentType(typeName)
        const fields = {...doc}
        fields.date = _createdAt
        fields.updatedAt = _updatedAt

        collection.addNode({
          id: _id,
          slug: doc.title,
          fields
        })
        callback()
      }),
    ])
  }


  async pump (streams) {
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
}

module.exports = SanitySource
