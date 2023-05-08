const {SecretManagerServiceClient} = require('@google-cloud/secret-manager');
const {Datastore} = require('@google-cloud/datastore');
const {AggregateField} = require('@google-cloud/datastore/build/src/aggregate');
const https = require("https");

const secretManagerClient = new SecretManagerServiceClient();
const datastore = new Datastore();

exports.getSecrets = function(keys) {
  return new Promise((resolve, reject) => {
    const promises = keys.map((key) => {
      return secretManagerClient.accessSecretVersion({
        name: `projects/abstrctn-prd/secrets/${key}/versions/latest`
      })
    });
    Promise.all(promises)
      .then((results) => {
        let secrets = {};
        results.map((result, idx) => {
          const value = result[0].payload.data.toString();
          secrets[keys[idx]] = value;
        })
        resolve(secrets);
      })
  });
}

exports.setSecrets = function(secrets) {
  return new Promise((resolve, reject) => {
    const promises = Object.keys(secrets).map((key) => {
      return secretManagerClient.addSecretVersion({
        parent: `projects/abstrctn-prd/secrets/${key}`,
        payload: {
          data: Buffer.from(secrets[key], 'utf8'),
        },
      });
    });
    Promise.all(promises)
      .then((results) => {
        resolve();
      })
  })
}

exports.refreshCredentials = function() {
  return new Promise((resolve, reject) => {
    exports.getSecrets(['ADOBE_REFRESH_TOKEN', 'ADOBE_CLIENT_SECRET'])
      .then((secrets) => {
        const request_body = `grant_type=refresh_token&refresh_token=${secrets.ADOBE_REFRESH_TOKEN}`;
        const request = https.request(
          {
            protocol: 'https:',
            hostname: 'ims-na1.adobelogin.com',
            port: 443,
            path: `/ims/token/v3`,
            method: 'POST',
            headers: {
              'Authorization': `Basic ${
                Buffer.from([
                  process.env.ADOBE_CLIENT_ID,
                  secrets.ADOBE_CLIENT_SECRET
                ].join(':'))
                .toString('base64')
              }`,
              'Content-Length': request_body.length,
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          },
          async function(response) {
            let responseData = '';
            response.on('data', (chunk) => {
              responseData += chunk;
            })
            response.on('end', () => {
              exports.writeToDatastore([{
                kind: 'api-call',
                data: {
                  endpoint: 'refreshToken',
                  catalog: process.env.ADOBE_CATALOG_ID,
                  responseStatus: response.statusCode,
                }
              }]);
              const {access_token, refresh_token} = JSON.parse(responseData);
              exports.setSecrets({
                ADOBE_ACCESS_TOKEN: access_token,
                ADOBE_REFRESH_TOKEN: refresh_token,
              }).then(() => {
                resolve(access_token);
              });
            })
          }
        )
        request.on('error', (err) => {
          reject(err);
        })
        request.write(request_body)
        request.end()
      })
    })
}

exports.getAdobeApiStats = async function() {
  const failureQuery = datastore.createQuery('api-call')
    .select('__key__')
    .filter('responseStatus', '>', 201)
  const [failures] = await datastore.runQuery(failureQuery);
  return {
    failures: failures.length,
  }
}

exports.getCameraSummaries = async function() {
  const query = datastore.createQuery('asset')
    .groupBy('camera_serial')
    .order('camera_serial')
    .order('timestamp', {descending: true});

  const [assets] = await datastore.runQuery(query);

  // Get count for each serial
  const promises = assets.map((asset) => {
    return new Promise(async (resolve, reject) => {
      const serial = asset.camera_serial;
      const q = datastore.createQuery('asset')
        .filter('timestamp', '>', new Date(new Date().getTime() - (1000 * 60 * 60 * 12)))
        .filter('camera_serial', serial);
      const aggregate = datastore
        .createAggregationQuery(q)
        .addAggregation(AggregateField.count())

      const [results] = await datastore.runAggregationQuery(aggregate);
      resolve({
        latest: asset,
        count: results[0].property_1,
      })
    });
  });
  const summaries = await Promise.all(promises);

  return summaries;
}

exports.writeToDatastore = function(entries) {
  return new Promise((resolve, reject) => {
    const promises = entries.map((entry) => {
      const entity = {
        key: datastore.key([entry.kind, entry.name].filter(Boolean)),
        excludeFromIndexes: entry.excludeFromIndexes,
        data: {
          ...entry.data,
          timestamp: new Date(),
          expires_at: new Date(new Date().getTime() + (1000 * 60 * 60 * 24)),
        },
      }
      return datastore.save(entity);
    });
    Promise.all(promises)
      .then(resolve);
  });
}

// https://stackoverflow.com/a/38552302
exports.parseJwt = function(token) {
  var base64Url = token.split('.')[1];
  var base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  var jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
  }).join(''));

  return JSON.parse(jsonPayload);
}

// Anticipate by 1 minute
exports.tokenExpired = function(token) {
  const jwt = exports.parseJwt(token);
  const expires_at = parseInt(jwt.created_at) + parseInt(jwt.expires_in);
  return expires_at < (new Date().getTime() - 60_000);
}

exports.getTzOffset = function() {
  const timeZone = 'America/New_York';
  const date = new Date(Date.UTC(2023, 5, 5, 12, 0, 0));

  let utcDate = new Date(date.toLocaleString('en-US', { timeZone: "UTC" }));
  let tzDate = new Date(date.toLocaleString('en-US', { timeZone: timeZone }));
  let offset = utcDate.getTime() - tzDate.getTime();
  return '-0' + (offset / 1000 / 60 / 60).toString() + '00';
}