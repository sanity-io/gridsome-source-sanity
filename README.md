# gridsome-source-sanity

[Sanity.io](https://www.sanity.io/) source for Gridsome. Requires Gridsome 0.7.1 or above.

## Table of contents

- [Basic usage](#basic-usage)
- [Options](#options)
- [Preview of unpublished content](#preview-of-unpublished-content)
- ["Raw" fields](#raw-fields)
- [Portable Text / Block Content](#portable-text--block-content)

## Basic usage

```shell
npm install gridsome-source-sanity
# or
yarn add gridsome-source-sanity
```

### Deploy GraphQL schema

This source plugin only works if you publish a [GraphQL API](https://www.sanity.io/docs/data-store/graphql) for your project and dataset. It will use the GraphQL API’s schema definitions to set the proper fields for your schema types.

```shell
~/yourSanityProjectFolder > sanity graphql deploy
```

Remember to redeploy the GraphQL API when you have changed the schema for Sanity.

### Plugin configuration

```javascript
module.exports = {
  plugins: [
    {
      use: 'gridsome-source-sanity',
      options: {
        projectId: '<projectId>',
        dataset: '<datasetName>',
        // Token is only required if dataset is private
        // or `overlayDrafts` is set to true
        token: '<tokenWithReadRights>',
        overlayDrafts: false,
        // Only enable real-time changes in development
        watchMode: process.env.NODE_ENV === "development",

        // If the Sanity GraphQL API was deployed using `--tag <name>`,
        // use `graphqlTag` to specify the tag name. Defaults to `default`.
        graphqlTag: 'default'
      }
    }
  ]
}
```

## Options

| Options       | Type    | Default   | Description                                                                                                                                                                  |
| ------------- | ------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| projectId     | string  |           | **[required]** Your Sanity project's ID                                                                                                                                      |
| dataset       | string  |           | **[required]** The dataset to fetch from                                                                                                                                     |
| token         | string  |           | Authentication token for fetching data from private datasets, or when using `overlayDrafts` [Learn more](https://www.sanity.io/docs/http-auth)                               |
| graphqlTag    | string  | `default` | If the Sanity GraphQL API was deployed using `--tag <name>`, use this to specify the tag name.                                                                               |
| overlayDrafts | boolean | `false`   | Set to `true` in order for drafts to replace their published version. By default, drafts will be skipped.                                                                    |
| watchMode     | boolean | `false`   | Set to `true` to keep a listener open and update with the latest changes in realtime. If you enable `overlayDrafts`, changes will be reflected almost down to each keypress. This option shouldn't be enabled during build or else the listener will prevent it from being completed. |
| typeName      | string  | `Sanity`  | Prefix for schema types and queries.                                                                                                                                         |

## Preview of unpublished content

Sometimes you might be working on some new content that is not yet published, which you want to make sure looks alright within your Gridsome site. By setting the `overlayDrafts` setting to `true`, the draft versions will as the option says "overlay" the regular document. In terms of Gridsome nodes, it will _replace_ the published document with the draft.

Keep in mind that drafts do not have to conform to any validation rules, so your frontend will usually want to double-check all nested properties before attempting to use them.

## "Raw" fields

Certain fields (portable text fields being one of them) will get a "raw JSON" representation in a field called `_raw<FieldName>`. For instance, a field named `body` will be mapped to `_rawBody`. This is a workaround for a known GraphQL introspection shortcoming that will be addressed in a future version of Sanity.

Quite often, you'll want to replace reference fields (eg `_ref: '<documentId>'`), with the actual document that is referenced. This is done automatically for regular fields, but within raw fields, you have to explicitly enable this behavior, by using the field-level `resolveReferences` argument:

```graphql
{
  allSanityProject {
    edges {
      node {
        _rawTasks(resolveReferences: {maxDepth: 5})
      }
    }
  }
}
```

## Portable Text / Block Content

Rich text in Sanity is usually represented as [Portable Text](https://www.portabletext.org/) (previously known as "Block Content").

These data structures can be deep and a chore to query (specifying all the possible fields). As [noted above](#raw-fields), there is a "raw" alternative available for these fields which is usually what you'll want to use.

You can install [sanity-blocks-vue-component](https://github.com/rdunk/sanity-blocks-vue-component) from npm and use it in your Gridsome project to serialize Portable Text. It lets you use your own Vue components to override defaults and render custom content types. [Learn more about Portable Text in our documentation](https://www.sanity.io/docs/content-studio/what-you-need-to-know-about-block-text).
