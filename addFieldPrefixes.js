module.exports = addFieldPrefixes

const prefixes = ['key', 'type', 'ref']

function addFieldPrefixes(obj) {
  if (Array.isArray(obj)) {
    return obj.map(addFieldPrefixes)
  }

  if (obj === null || typeof obj !== 'object') {
    return obj
  }

  return Object.keys(obj).reduce((acc, key) => {
    if (prefixes.includes(key)) {
      const prefixed = `_${key}`
      if (!obj[prefixed]) {
        acc[prefixed] = obj[key]
        return acc
      }
    }

    acc[key] = addFieldPrefixes(obj[key])
    return acc
  }, {})
}
