# @sanity/gridsome-source-sanity

[Sanity.io](https://www.sanity.io) source for Gridsome. Package under development. API might change before v1.

## Install

```shell
npm install @sanity/gridsome-source-sanity
# or
yarn add @sanity/gridsome-source-sanity
```

## Usage

### Deploy GraphQL schema

This source plugin works only properly if you publish a [GraphQL API](https://www.sanity.io/docs/data-store/graphql) for your project and dataset. It will use the GraphQL API’s schema definitions to set the proper fields.

```shell
~/yourSanityProjectFolder > sanity graphql deploy
```

Remember to redeploy the GraphQL API when you have changed the schema for Sanity.

### Plugin configuration

```javascript
module.exports = {
  plugins: [
    {
      use: '@sanity/gridsome-source-sanity',
      options: {
        typeName: 'Sanity',
        projectId: '<ProjectId>',
        dataset: '<DatasetName>',
        token: '<TokenWithReadRights>',
        overlayDrafts: false,
        watchMode: false
      }
    }
  ]
}
```
