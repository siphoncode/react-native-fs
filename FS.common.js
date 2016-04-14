'use strict';

// This file supports both iOS and Android

// Stop bluebird going nuts because it can't find "self"
if (typeof self === 'undefined') {
  global.self = global;
}

var RNFSManager = require('react-native').NativeModules.RNFSManager;
var NativeAppEventEmitter = require('react-native').NativeAppEventEmitter;  // iOS
var DeviceEventEmitter = require('react-native').DeviceEventEmitter;        // Android
var Platform  = require('react-native').Platform;
var Promise = require('bluebird');
var base64 = require('base-64');
var utf8 = require('utf8');

var _readDir = Promise.promisify(RNFSManager.readDir);
var _exists = Promise.promisify(RNFSManager.exists);
var _stat = Promise.promisify(RNFSManager.stat);
var _readFile = Promise.promisify(RNFSManager.readFile);
var _writeFile = Promise.promisify(RNFSManager.writeFile);
var _moveFile = Promise.promisify(RNFSManager.moveFile);
var _unlink = Promise.promisify(RNFSManager.unlink);
var _mkdir = Promise.promisify(RNFSManager.mkdir);
var _downloadFile = Promise.promisify(RNFSManager.downloadFile);
var _pathForBundle = Promise.promisify(RNFSManager.pathForBundle);

var convertError = (err) => {
  if (err.isOperational && err.cause) {
    err = err.cause;
  }

  var error = new Error(err.description || err.message);
  error.code = err.code;
  throw error;
};

var NSFileTypeRegular = RNFSManager.NSFileTypeRegular;
var NSFileTypeDirectory = RNFSManager.NSFileTypeDirectory;

var jobId = 0;

var getJobId = () => {
  jobId += 1;
  return jobId;
};

var processDirPath = function(path) {
  // Takes to be used in conjunction with NS<TYPE>Directory.
  // Appends /siphon-data-<app_id>/<Type>/ to the path. This makes
  // react-native-fs Sandbox-friendly
  if (typeof path !== 'string') {
    throw new Error('Path must be a string. Provided was ' + typeof path);
  }

  var a = __SIPHON.appID;
  if (a == undefined || a == null || a.length < 1) {
    throw new Error('Global appID must be set.');
  }

  var ext = 'siphon-data-' + a;
  var lastChar = path.slice(-1);
  if (lastChar !== '/') {
    ext = '/' + ext;
  }

  return path + ext;
};

var normalizePath = function(path) {
  if (typeof path !== 'string') {
    throw new Error('Path must be a string. Provided was ' + typeof path);
  }

  var schemeless;
  var scheme;
  if (path.indexOf('://') > -1) {
    var split = path.split('://');
    scheme = split[0];
    schemeless = split[1];
  } else {
    scheme = null;
    schemeless = path;
  }

  var parts = schemeless.split('/');
  var normParts = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (p == '.') {
      continue;
    } else if (p == '..') {
      normParts.pop();
    } else {
      normParts.push(p);
    }
  }

  var normalized;
  if (scheme) {
    normalized = scheme + '://' + normParts.join('/');
  } else {
    normalized = normParts.join('/');
  }

  return normalized;
};

var rootDir = function(path) {
  // Return the processed root if it is valid
  path = normalizePath(path);
  var root = null;
  // Universal
  var validDirs = [
    processDirPath(RNFSManager.NSCachesDirectoryPath),
    processDirPath(RNFSManager.NSDocumentDirectoryPath),
  ];

  // iOS only
  if (Platform.OS == 'ios') {
    validDirs.push(processDirPath(RNFSManager.NSLibraryDirectoryPath));
  }

  for (var i = 0; i < validDirs.length; i++) {
    var d = validDirs[i];
    if (path.substring(0, d.length) == d) {
      root = path.substring(0, d.length);
      break;
    }
  }

  return root;
};

var RNFS = {

  _ensureValidRoot(path) {
    // We want the app's subdirectories to behave like their regular
    // analogues, so we ensure they exist when they are referenced.
    return new Promise(function(resolve, reject) {
      var root = rootDir(path);

      if (!root) {
        reject(new Error('Warning: Invalid directory for Siphon app. ' +
              'Please use one of DocumentDirectoryPath, ' +
              'CachesDirectoryPath or LibraryDirectoryPath (iOS only).'));
      }

      var excludeFromBackup = false;
      if (root == processDirPath(RNFSManager.NSCachesDirectoryPath)) {
        excludeFromBackup = true;
      }

      return _mkdir(root, excludeFromBackup)
        .then(() => resolve())
        .catch((err) => reject(err));
    });
  },

  readDir(dirpath) {
    return RNFS._ensureValidRoot(dirpath)
      .then(() => {
        return _readDir(dirpath)
          .then(files => {
            return files.map(file => ({
              name: file.name,
              path: file.path,
              size: file.size,
              isFile: () => file.type === NSFileTypeRegular,
              isDirectory: () => file.type === NSFileTypeDirectory,
            }));
          })
          .catch(convertError);
      })
      .catch(convertError);
  },

  // Node style version (lowercase d). Returns just the names
  readdir(dirpath) {
    return RNFS._ensureValidRoot(dirpath)
      .then(() => {
        return RNFS.readDir(dirpath)
          .then(files => {
            return files.map(file => file.name);
          });
      });
  },

  stat(filepath) {
    return RNFS._ensureValidRoot(filepath)
      .then(() => {
        return _stat(filepath)
          .then((result) => {
            return {
              'ctime': new Date(result.ctime*1000),
              'mtime': new Date(result.mtime*1000),
              'size': result.size,
              'mode': result.mode,
              isFile: () => result.type === NSFileTypeRegular,
              isDirectory: () => result.type === NSFileTypeDirectory,
            };
          })
          .catch(convertError);
      });
  },

  exists(filepath) {
    return RNFS._ensureValidRoot(filepath)
      .then(() => {
        return _exists(filepath)
          .catch(convertError);
      });
  },

  readFile(filepath, encoding) {
    if (!encoding) encoding = 'utf8';
    return RNFS._ensureValidRoot(filepath)
      .then(() => {
        return _readFile(filepath)
          .then((b64) => {
            var contents;

            if (encoding === 'utf8') {
              contents = utf8.decode(base64.decode(b64));
            } else if (encoding === 'ascii') {
              contents = base64.decode(b64);
            } else if (encoding === 'base64') {
              contents = b64;
            } else {
              throw new Error('Invalid encoding type "' + encoding + '"');
            }

            return contents;
          })
          .catch(convertError);
      });
  },

  writeFile(filepath, contents, encoding, options) {
    var b64;

    if (!encoding) encoding = 'utf8';

    if (encoding === 'utf8') {
      b64 = base64.encode(utf8.encode(contents));
    } else if (encoding === 'ascii') {
      b64 = base64.encode(contents);
    } else if (encoding === 'base64') {
      b64 = contents;
    } else {
      throw new Error('Invalid encoding type "' + encoding + '"');
    }

    return RNFS._ensureValidRoot(filepath)
      .then(() => {
        return _writeFile(filepath, b64, options)
          .catch(convertError);
      });
  },

  moveFile(filepath, destPath) {
    return RNFS._ensureValidRoot(filepath)
      .then(() => {
        return _moveFile(filepath, destPath)
          .catch(convertError);
      });
  },

  pathForBundle(bundleName) {
    console.log('Warning: pathForBundle is disabled by Siphon.');
  },

  unlink(filepath) {
    return RNFS._ensureValidRoot(filepath)
      .then(() => {
        return _unlink(filepath)
          .catch(convertError);
      });
  },

  mkdir(filepath, excludeFromBackup) {
    return RNFS._ensureValidRoot(filepath)
      .then(() => {
        excludeFromBackup = !!excludeFromBackup;
        return _mkdir(filepath, excludeFromBackup)
          .catch(convertError);
      });
  },

  downloadFile(fromUrl, toFile, begin, progress) {
    var jobId = getJobId();
    var subscriptionIos, subscriptionAndroid;

    if (!begin) begin = (info) => {
      console.log('Download begun:', info);
    };

    if (begin) {
      // Two different styles of subscribing to events for different platforms, hmmm....
      if (NativeAppEventEmitter.addListener)
        subscriptionIos = NativeAppEventEmitter.addListener('DownloadBegin-' + jobId, begin);
      if (DeviceEventEmitter.addListener)
        subscriptionAndroid = DeviceEventEmitter.addListener('DownloadBegin-' + jobId, begin);
    }

    if (progress) {
      if (NativeAppEventEmitter.addListener)
        subscriptionIos = NativeAppEventEmitter.addListener('DownloadProgress-' + jobId, progress);
      if (DeviceEventEmitter.addListener)
        subscriptionAndroid = DeviceEventEmitter.addListener('DownloadProgress-' + jobId, progress);
    }

    return RNFS._ensureValidRoot(toFile)
      .then(() => {
        return _downloadFile(fromUrl, toFile, jobId)
          .then(res => {
            if (subscriptionIos) subscriptionIos.remove();
            if (subscriptionAndroid) subscriptionAndroid.remove();
            return res;
          })
          .catch(convertError);
      });
  },

  stopDownload(jobId) {
    RNFSManager.stopDownload(jobId);
  },

  CachesDirectoryPath: processDirPath(RNFSManager.NSCachesDirectoryPath),
  DocumentDirectoryPath: processDirPath(RNFSManager.NSDocumentDirectoryPath),
};

if (Platform.OS == 'ios') {
  RNFS.LibraryDirectoryPath = processDirPath(RNFSManager.NSLibraryDirectoryPath);
}

module.exports = RNFS;
