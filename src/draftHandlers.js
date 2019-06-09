const through = require('through2')

function filter(doc, enc, callback) {
  return isDraft(doc) ? callback() : callback(null, doc)
}

function isDraft(doc) {
  return doc && doc._id && isDraftId(doc._id)
}

function isDraftId(id) {
  return id.startsWith('drafts.')
}

function unprefixDraftId(id) {
  return id.replace(/^drafts\./, '')
}

exports.isDraft = isDraft
exports.isDraftId = isDraftId
exports.unprefixDraftId = unprefixDraftId

exports.prefixId = id => (id.startsWith('drafts.') ? id : `drafts.${id}`)

exports.unprefixId = id => id.replace(/^drafts\./, '')

exports.removeDrafts = () => through.obj(filter)

exports.extractDrafts = (drafts, published) =>
  through.obj((doc, enc, callback) => {
    if (isDraft(doc)) {
      drafts.push(doc)
      callback() // Don't include in doc stream
      return
    }

    published.set(doc._id, doc)
    callback(null, doc)
  })
