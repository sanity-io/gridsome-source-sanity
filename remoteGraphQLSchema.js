const {
  parse
} = require('graphql')

module.exports = async (client) => {
  const graphqlApi = 'default'
  const config = client.config()
  const {
    dataset
  } = config

  let api
  try {
    api = await client.request({
      url: `/apis/graphql/${dataset}/${graphqlApi}`,
      headers: {
        Accept: 'application/graphql'
      },
    })
  } catch (err) {
    const code = err && err.response && err.response.statusCode
    const message = (err && err.response && err.response.body && err.response.body.message) || (err.response && err.response.statusMessage) || err.message

    const gqlBenefits = [
      'Schemas will be much cleaner, and you will have less problems with missing fields',
      'See https://github.com/sanity-io/gatsby-source-sanity#missing-fields for more info',
    ].join('\n')

    const is404 = code === 404 || /schema not found/i.test(message)
    const hint = is404 ? ` - have you run \`sanity graphql deploy\` yet?\n${gqlBenefits}` : ''

    throw new Error(`${message}${hint}`, is404)
  }

  const parsed = parse(api)

  return parsed.definitions.filter(def => def.kind === 'ObjectTypeDefinition')
}
