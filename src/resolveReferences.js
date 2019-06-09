const {unprefixDraftId} = require('./draftHandlers')

module.exports = function resolveReferences(obj, depth, maxDepth, context) {
  const {store, getUid, overlayDrafts} = context
  const {getNodeByUid} = store

  if (Array.isArray(obj)) {
    return depth <= maxDepth
      ? obj.map(item => resolveReferences(item, depth + 1, maxDepth, context))
      : obj
  }

  if (obj === null || typeof obj !== 'object') {
    return obj
  }

  if (typeof obj._ref === 'string') {
    const id = obj._ref
    const node = getNodeByUid(getUid(overlayDrafts ? unprefixDraftId(id) : id))
    return node && depth <= maxDepth
      ? resolveReferences(node, depth + 1, maxDepth, context) // Recurse deeper!
      : obj
  }

  const initial = {}
  return Object.keys(obj).reduce((acc, key) => {
    acc[key] = resolveReferences(obj[key], depth + 1, maxDepth, context)
    return acc
  }, initial)
}
