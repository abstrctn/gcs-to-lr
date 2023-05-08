const functions = require('@google-cloud/functions-framework');
const https = require("https");
const crypto = require("crypto");
const path = require("path");
const {Storage} = require('@google-cloud/storage');
const ExifReader = require('exifreader');

const {
  tokenExpired,
  parseJwt,
  getSecrets,
  writeToDatastore,
  refreshCredentials,
  getTzOffset,
  getAdobeApiStats,
  getCameraSummaries,
} = require('./helpers.js');
const { eventNames } = require('process');

functions.http('statusData', (req, res) => {
  if (req.method === 'OPTIONS') {
    // Send response to OPTIONS requests
    res.set('Access-Control-Allow-Methods', 'GET');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '3600');
    res.status(204).send('');

  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const apiStatsPromise = getAdobeApiStats();
    const cameraSummariesPromise = getCameraSummaries();

    getSecrets(['ADOBE_ACCESS_TOKEN', 'ADOBE_CLIENT_SECRET', 'ADOBE_REFRESH_TOKEN'])
      .then((secrets) => {
        const jwt = parseJwt(secrets.ADOBE_ACCESS_TOKEN);
        const expires_at = parseInt(jwt.created_at) + parseInt(jwt.expires_in);
        Promise.all([apiStatsPromise, cameraSummariesPromise]).then((results) => {
          const [adobeApiStats, cameraSummaries] = results;

          res.send(JSON.stringify({
            expires_in: expires_at - new Date().getTime(),
            expired: tokenExpired(secrets.ADOBE_ACCESS_TOKEN),
            adobeApiStats,
            cameraSummaries,
          }));
        })
      });
  }
});

functions.http('status', (req, res) => {
  res.sendFile('/workspace/status.html');
});

exports.index = async (eventData, context, callback) => {
  console.log({eventData})
  const storage = new Storage();

  // FTP client touches an empty file before finally uploading
  // the rest of the data.
  if (eventData.size == 0) { return callback() }
  
  const bucket = storage.bucket(eventData.bucket);
  const file = bucket.file(eventData.name);
  const file_name = path.basename(eventData.name);

  const uuid = crypto.randomUUID().replaceAll("-", "");
  console.log({uuid});
  const readStream = file.createReadStream();

  // only a1 files seem to have metadata at front of file
  // const xmpReadOptions = {};
  // if (eventData.name.indexOf('a1/') == 0) xmpReadOptions = {start: 0, end: 128 * 1024};
  const xmpReadStream = file.createReadStream({start: 0, end: 128 * 1024});

  let secrets = await getSecrets(['ADOBE_ACCESS_TOKEN', 'ADOBE_API_KEY']);

  // Check for expired access token
  if (tokenExpired(secrets.ADOBE_ACCESS_TOKEN)) {
    console.log('token expired, refreshing...')
    secrets.ADOBE_ACCESS_TOKEN = await refreshCredentials(secrets);
    console.log('token refreshed')
  }

  const request_body = JSON.stringify({
    "subtype": "image",
    "payload": {
      "userCreated": new Date().toISOString(),
      "userUpdated": new Date().toISOString(),
      "captureDate": "0000-00-00T00:00:00",
      "importSource": {
        "fileName": file_name,
        "importedOnDevice": "google-cloud-function-v1",
        "importedBy": process.env.ADOBE_ACCOUNT_ID,
        "importTimestamp": new Date().toISOString()
      }
    }
  });
  console.log({request_body})

  const req_create = https.request(
    {
      protocol: 'https:',
      hostname: 'lr.adobe.io',
      port: 443,
      path: `/v2/catalogs/${process.env.ADOBE_CATALOG_ID}/assets/${uuid}`,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${secrets.ADOBE_ACCESS_TOKEN}`,
        'X-Api-Key': secrets.ADOBE_API_KEY,
        'Content-Length': request_body.length,
        'Content-Type': 'application/json'
      }
    },
    async function(response) {
      console.log("res1", response.statusCode, response.headers)
      let responseData = '';
      response.on('data', (chunk) => {
        responseData += chunk;
      });
      response.on('end', () => {
        writeToDatastore([{
          kind: 'api-call',
          data: {
            endpoint: 'createAsset',
            catalog: process.env.ADOBE_CATALOG_ID,
            asset_id: uuid,
            responseStatus: response.statusCode,
            responseBody: responseData,
          }
        }]);
        console.log({responseData});
      })
      const req_upload = https.request(
        {
          protocol: 'https:',
          hostname: 'lr.adobe.io',
          port: 443,
          path: `/v2/catalogs/${process.env.ADOBE_CATALOG_ID}/assets/${uuid}/master`,
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${secrets.ADOBE_ACCESS_TOKEN}`,
            'X-Api-Key': secrets.ADOBE_API_KEY,
            'Content-Type': 'application/octet-stream',
            'Content-Length': eventData.size
          }
        },
        (response) => {
          console.log('res2', response.statusCode)
          let responseData = '';
          response.on('data', (chunk) => {
            responseData += chunk;
          });
          response.on('end', () => {
            writeToDatastore([{
              kind: 'api-call',
              data: {
                endpoint: 'createAssetOriginal',
                catalog: process.env.ADOBE_CATALOG_ID,
                asset_id: uuid,
                responseStatus: response.statusCode,
                responseBody: responseData,
              }
            }]);
            console.log({responseData});

            let chunks = [];
            xmpReadStream
              .on('data', (chunk) => chunks.push(chunk))
              .on('end', () => {
                const buffer = Buffer.concat(chunks);
                const exif = ExifReader.load(buffer);
                writeToDatastore([{
                  kind: 'asset',
                  excludeFromIndexes: [
                    'thumbnail',
                  ],
                  data: {
                    asset_id: uuid,
                    name: file_name,
                    camera_make: exif.Make.description,
                    camera_model: exif.Model.description,
                    camera_serial: exif.BodySerialNumber?.description,
                    asset_created: new Date(exif.DateTime.description.replace(':', '-').replace(':', '-') + getTzOffset()),
                    thumbnail: Buffer.from(exif.Thumbnail.image).toString("base64"),
                  }
                }]);
                callback();
              })
          });
        }
      );
      console.log('uploading...');
      readStream.pipe(req_upload)
        .on('finish', () => {
          console.log('finish upload')
          req_upload.end()
        })
    }
  );
  req_create.write(request_body)
  req_create.end()
}