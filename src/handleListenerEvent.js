const debug = require('./debug')
const {unprefixId, isDraftId} = require('./draftHandlers')

module.exports = function handleListenerEvent(event, options, docs) {
  const {store, getUid, overlayDrafts, addDocumentToCollection, getCollectionForType} = options

  const uid = getUid(unprefixId(event.documentId))
  const current = store.getNodeByUid(uid)
  const collection = current && getCollectionForType(current._type, store)
  const published = docs.published.get(unprefixId(event.documentId))
  const touchedIsDraft = isDraftId(event.documentId)
  const currentIsDraft = current && isDraftId(current._id)

  // In non-overlay mode, things are pretty simple -
  // replace the current on create/update, delete the current if it disappears
  if (!overlayDrafts) {
    if (touchedIsDraft) {
      debug('Document is draft, but draft overlay disabled. Skipping.')
      return
    }

    if (event.transition !== 'disappear') {
      // Created/updated, replace current
      debug('Published document created or updated, replace/create')
      addDocumentToCollection(event.result, store)
    } else if (current) {
      // Deleted a node that we currently have, delete it
      debug('Published document deleted, remove')
      collection.removeNode(unprefixId(event.documentId))
    }

    return
  }

  // In overlay mode, things are a bit more tricky.
  // We need to keep a copy of the published documents around so we can
  // put the published version back if a draft is discarded (deleted).
  // If a published document is updated but there is still a draft,
  // we still want to show the draft. A lot of cases here, unfortunately.
  if (event.transition === 'disappear') {
    // A document was deleted
    if (touchedIsDraft && published) {
      debug('Draft deleted, published version exists, restore published version')
      addDocumentToCollection(published, store)
    } else if (touchedIsDraft && !published && current) {
      debug('Draft deleted, no published version exist, delete node')
      collection.removeNode(unprefixId(current._id))
    } else if (!touchedIsDraft && currentIsDraft && published) {
      debug('Published version deleted, but we have draft, remove published from working set')
      docs.published.delete(event.documentId)
    } else if (!touchedIsDraft && !currentIsDraft && current) {
      debug('Published version deleted, we have no draft, remove node entirely')
      collection.removeNode(unprefixId(current._id))
      docs.published.delete(event.documentId)
    }

    return
  }

  //  Overlay mode, and a document was updated / created
  if (touchedIsDraft) {
    debug(current ? 'Replace the current draft with a new draft' : 'New draft discovered')
    addDocumentToCollection(event.result, store)

    // If the currently used node is a published one, make sure we keep a copy
    if (current && !currentIsDraft) {
      docs.published.set(unprefixId(event.documentId), current)
    }
  } else if (currentIsDraft) {
    // Creating/updating a published document, but we have a draft
    // Keep the draft as the current, but update our set of published docs
    debug('Created/updating published document, but draft overlays it')
    docs.published.set(event.documentId, event.result)
  } else {
    // Creating/updating a published document, and there is no draft version present
    // Replace the current version with the new one
    debug('Created/updating published document, no draft present')
    addDocumentToCollection(event.result, store)
  }
}
