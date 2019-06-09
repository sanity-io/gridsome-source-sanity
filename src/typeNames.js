const {startCase} = require('lodash')

function getGraphQLTypeName(str) {
  return startCase(str).replace(/\s+/g, '')
}

function normalizeTypeName(typeName) {
  return typeName.replace(/^SanitySanity/, 'Sanity')
}

exports.getGraphQLTypeName = getGraphQLTypeName
exports.normalizeTypeName = normalizeTypeName
