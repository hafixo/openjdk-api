const request = require('request');
const _ = require('underscore');
const fs = require('fs');
const Q = require('q');

const newCache = {};
const oldCache = {};

let auth = undefined;

function formErrorResponse(error, response, body) {
  return {
    error: error,
    response: response,
    body: body
  };
}

function readAuthCreds() {
  if (auth === undefined) {
    try {
      console.log("Reading auth");
      auth = fs.readFileSync('/home/jenkins/github.auth').toString("ascii").trim();
      console.log("Auth found")
    } catch (e) {
      console.log("No github creds found");
      auth = null
    }
  }
}

function getCooldown() {
  if (auth !== undefined && auth !== null) {
    // 1 min
    return 6000;
  } else {
    // 30 min
    return 1800000;
  }
}

function formRequest(url) {
  readAuthCreds();

  const options = {
    url: url,
    headers: {
      'User-Agent': 'adoptopenjdk-admin openjdk-api'
    }
  };

  if (auth !== undefined && auth !== null) {
    const authHeader = new Buffer(auth).toString('base64');
    options.headers['Authorization'] = 'Basic ' + authHeader
  }

  return options;
}


// Get from url, and store the result into a cache
// 1. If last check was < 2 min ago, return last result
// 2. Check if file has been modified
// 3. If file is not modified return cached value
// 4. If modified return new data and add it to the cache
function cachedGet(url, cache) {
  const deferred = Q.defer();
  const options = formRequest(url);

  if (cache.hasOwnProperty(options.url) && Date.now() < cache[options.url].cacheTime) {
    // For a given file check at most once every 10 min
    console.log("cache hit cooldown");
    deferred.resolve(cache[options.url].body);
  } else {
    console.log("Checking " + options.url);
    request(options, function (error, response, body) {
      if (error !== null) {
        deferred.reject(formErrorResponse(error, response, body));
        return;
      }

      if (response.statusCode === 200) {

        console.log("Remaining requests: " + response.headers['x-ratelimit-remaining']);

        cache[options.url] = {
          cacheTime: Date.now() + getCooldown(),
          body: JSON.parse(body)
        };
        deferred.resolve(cache[options.url].body)
      } else if (response.statusCode === 403 && cache.hasOwnProperty(options.url)) {
        // Hit the rate limit, just serve up old cache

        // do a short cooldown on this
        cache[options.url].cacheTime = Date.now() + (getCooldown() / 2);
        deferred.resolve(cache[options.url].body)
      }
      else {
        deferred.reject(formErrorResponse(error, response, body));
      }
    });
  }
  return deferred.promise;
}

function getInfoForNewRepo(version) {
  return cachedGet(`https://api.github.com/repos/AdoptOpenJDK/${version}-binaries/releases`, newCache);
}

function getInfoForOldRepo(version, releaseType) {
  let deferred = Q.defer();

  let hotspotPromise = cachedGet(`https://api.github.com/repos/AdoptOpenJDK/${version}-${releaseType}/releases`, oldCache);
  let openj9Promise;

  if (version.indexOf('amber') > 0) {
    openj9Promise = Q.fcall(function () {
      return {}
    });
  } else {
    openj9Promise = cachedGet(`https://api.github.com/repos/AdoptOpenJDK/${version}-openj9-${releaseType}/releases`, oldCache);
  }

  Q.allSettled([hotspotPromise, openj9Promise])
    .then(function (results) {
      let hotspotResult = results[0];
      let openj9Result = results[1];
      if (hotspotResult.state !== "fulfilled" && openj9Result.state !== "fulfilled") {
        deferred.reject(hotspotResult.reason);
      } else {
        let hotspotData = hotspotResult.state === "fulfilled" ? hotspotResult.value : [];
        let openj9Data = openj9Result.state === "fulfilled" ? openj9Result.value : [];

        const unifiedJson = _.union(hotspotData, openj9Data);
        deferred.resolve(unifiedJson);
      }
    });

  return deferred.promise;
}

function markOldReleases(oldReleases) {
  return _.chain(oldReleases)
    .map(function (release) {
      release.oldRepo = true;
      return release;
    })
    .value();
}

exports.getInfoForVersion = function (version, releaseType) {
  let deferred = Q.defer();

  Q.allSettled([getInfoForOldRepo(version, releaseType), getInfoForNewRepo(version)])
    .then(function (results) {
      let oldData = results[0];
      let newData = results[1];

      if (oldData.state !== "fulfilled" && newData.state !== "fulfilled") {
        deferred.reject(oldData.reason);
      } else {
        let oldD = oldData.state === "fulfilled" ? oldData.value : [];
        let newD = newData.state === "fulfilled" ? newData.value : [];

        oldD = markOldReleases(oldD);

        const unifiedJson = _.union(oldD, newD);
        deferred.resolve(unifiedJson);
      }
    });
  return deferred.promise;
};
