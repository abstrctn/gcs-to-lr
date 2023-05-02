# GCS to Lightroom Cloud Function

A Google Cloud Function that relays files uploaded to a Google Cloud Storage bucket to the Adobe Lightroom API to be imported into a user's catalog.

## Setup

In lieu of a full OAuth integration at this point, the function relies on a number of variables stored as secrets in Secret Manager:
* `ADOBE_API_KEY` - Api key for an Adobe OAuth Web App
* `ADOBE_CLIENT_ID` - Client ID for the web app
* `ADOBE_CLIENT_SECRET` - Client secret for the web app
* `ADOBE_ACCOUNT_ID` - User's internal adobe account id (found by viewing an existing asset's `.importSource.importedBy` attribute in a user's catalog)
* `ADOBE_CATALOG_ID` - User's internal catalog ID (found in the `/rels/catalog` link in the source code of a shared album)
* `ADOBE_ACCESS_TOKEN` - A short-lived (24h) access token obtained using [Adobe's OAuth 2.0 Playground](https://adobeioruntime.net/api/v1/web/io-solutions/adobe-oauth-playground/oauth.html)

The access token needs to be input manually every 24 hours for this to work, until I get around to using the refresh token to extend access.

Note: Required scopes when generating an access token in the playground:
`openid,lr_partner_apis,lr_partner_rendition_apis,offline_access`

## Deploying

Run `make deploy`.

But first change any values such as your GCS bucket name and the location of secrets (which you could specify as env variables instead to simplify setup).

## To Do

* Handle errors in API responses
* Add mechanism to update an access token from a given refresh token
  * And later, a multi-user solution for oauth
* See if GCF gen2 is viable; initially the download speed from GCS was very slow when using gen2