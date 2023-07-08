const https = require("https");

const { writeToDatastore } = require("./helpers");

// options = { method, path }
function generateApiEndpoint(options) {
  const {name, path, method, content_type} = options;

  return function({
    body, // string or object
    api_key,
    access_token,
    params = {},
  }) {
    const generatedPath = path(params);

    return new Promise((resolve, reject) => {
      console.log(`Running ${name}...`)
      const request = https.request(
        {
          protocol: 'https:',
          hostname: 'lr.adobe.io',
          port: 443,
          path: generatedPath,
          method: method,
          headers: {
            'Authorization': `Bearer ${access_token}`,
            'X-Api-Key': api_key,
            'Content-Length': body.length,
            'Content-Type': content_type,
          }
        },
        async function(response) {
          console.log('response', response.statusCode, response.headers);

          let responseData = '';
          response.on('data', (chunk) => {
            responseData += chunk;
          });
          response.on('end', () => {
            console.log('responseData', {responseData});

            // Log api call statuses
            writeToDatastore([{
              kind: 'api-call',
              data: {
                endpoint: name,
                catalog: params.catalog_id,
                asset_id: params.uuid,
                responseStatus: response.statusCode,
                responseBody: responseData,
              }
            }]);
          
            resolve({request, response, responseData});
          });
        }
      )

      request.on('error', (e) => {
        console.log(`Error running ${name}`);
        console.error(e);
      });

      // Handle string and stream request bodies
      // TK, do this outside
      if (typeof body == 'string') {
        request.write(body);
        request.end();

      } else if (body?.stream) {
        body.stream.pipe(request)
          .on('error', (e) => {
            console.log('error piping');
            console.error(e);
          })
          .on('finish', () => {
            console.log('finished piping')
            request.end();
          })
      }
    })
  }
}

exports.createAsset = generateApiEndpoint({
  name: 'createAsset',
  path: (params) => {
    return `/v2/catalogs/${params.catalog_id}/assets/${params.uuid}`
  },
  method: 'PUT',
  content_type: 'application/json',
});

exports.createAssetOriginal = generateApiEndpoint({
  name: 'createAssetOriginal',
  path: (params) => {
    return `/v2/catalogs/${params.catalog_id}/assets/${params.uuid}/master`
  },
  method: 'PUT',
  content_type: 'application/octet-stream'
});