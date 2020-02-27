const {parse} = require('graphql')

module.exports = async (client, graphqlTag) => {
  const config = client.config()
  const {dataset} = config

  let api
  try {
    api = await client.request({
      url: `/apis/graphql/${dataset}/${graphqlTag}`,
      headers: {
        Accept: 'application/graphql'
      }
    })
  } catch (err) {
    const code = err && err.response && err.response.statusCode
    const message =
      (err && err.response && err.response.body && err.response.body.message) ||
      (err.response && err.response.statusMessage) ||
      err.message

    const is404 = code === 404 || /schema not found/i.test(message)
    const hint = is404 ? ` - have you run \`sanity graphql deploy\` yet?` : ''

    throw new Error(`${message}${hint}`, is404)
  }

  return parse(api)
}
