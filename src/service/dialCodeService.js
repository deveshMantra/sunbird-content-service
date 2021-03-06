/**
 * @name : dialCodeService.js
 * @description :: Responsible for handle dial code service
 * @author      :: Anuj Gupta
 */

var async = require('async')
var path = require('path')
var _ = require('lodash')
var contentProvider = require('sb_content_provider_util')
var respUtil = require('response_util')
var LOG = require('sb_logger_util')
var configUtil = require('sb-config-util')

var messageUtils = require('./messageUtil')
var utilsService = require('../service/utilsService')
var BatchImageService = require('./dialCode/batchImageService')
var dialCodeServiceHelper = require('./dialCode/dialCodeServiceHelper')
var dbModel = require('./../utils/cassandraUtil').getConnections('dialcodes')
var ImageService = require('./dialCode/imageService.js')
var filename = path.basename(__filename)
var dialCodeMessage = messageUtils.DIALCODE
var responseCode = messageUtils.RESPONSE_CODE

function getBatchImageInstance(req) {
  let defaultConfig = {
    'errorCorrectionLevel': 'H',
    'pixelsPerBlock': 2,
    'qrCodeMargin': 3,
    'textFontName': 'Verdana',
    'textFontSize': 11,
    'textCharacterSpacing': 0.1,
    'imageFormat': 'png',
    'colourModel': 'Grayscale',
    'imageBorderSize': 1
  }
  let config = _.merge(defaultConfig, req.qrCodeSpec)
  let batchImageService = new BatchImageService(config)
  return batchImageService
}

function prepareQRCodeRequestData(dialcodes, config, channel, publisher, contentId, cb) {
  let imageService = new ImageService(config)
  // get dialcodes data from DB
  let tasks = {}
  let data = {}
  let dialCodesMap = []
  for (let index = 0; index < dialcodes.length; index++) {
    const element = dialcodes[index]
    tasks[element] = function (callback) {
      imageService.insertImg(element, channel, publisher, callback)
    }
  }

  async.parallelLimit(tasks, 100, function (err, results) {
    if (err) {
      cb(err)
    } else {
      _.forIn(results, function (fileName, key) {
        let dialData = {
          'data': process.env.sunbird_dial_code_registry_url + key,
          'text': key,
          'id': fileName
        }
        dialCodesMap.push(dialData)
      })
      data['dialcodes'] = dialCodesMap
      data['objectId'] = contentId || channel
      data['config'] = config
      data['storage'] = {
        'container': 'dial'
      }
      data['storage']['path'] = publisher ? (channel + '/' + publisher + '/') : (channel + '/')

      // if content id present then we will send zip file name
      if (contentId) {
        var qs = {
          mode: 'edit',
          fields: 'medium,subject,gradeLevel'
        }
        contentProvider.getContentUsingQuery(contentId, qs, {},
          function (err, res) {
            if (err || res.responseCode !== responseCode.SUCCESS) {
              LOG.error({
                'api': 'reserveDialCode',
                'message': 'Error while getting content',
                'err': err,
                'res': res
              })
              cb(null, data)
            } else {
              let medium = _.get(res, 'result.content.medium')
              let subject = _.get(res, 'result.content.subject')
              let gradeLevel = _.get(res, 'result.content.gradeLevel')
              let fileNameArray = [contentId, medium]
              fileNameArray = _.concat(fileNameArray, gradeLevel)
              fileNameArray.push(subject)
              fileNameArray.push(Date.now())
              fileNameArray = _.compact(fileNameArray)

              let fileName = _.join(fileNameArray, '_')
              data['storage']['fileName'] = fileName
              cb(null, data)
            }
          })
      } else {
        cb(null, data)
      }
    }
  })
}
/**
 * This function helps to generate dialcode
 * @param {type} req
 * @param {type} response
 * @returns {object} return response object with http status
 */
function generateDialCodeAPI(req, response) {
  var data = req.body
  var rspObj = req.rspObj

  if (!data.request || !data.request.dialcodes) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'generateDialCodeAPI',
      'Error due to required params are missing', data.request))
    rspObj.errCode = dialCodeMessage.GENERATE.MISSING_CODE
    rspObj.errMsg = dialCodeMessage.GENERATE.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }

  if (!_.get(data, 'request.dialcodes.count') || !_.isSafeInteger(data.request.dialcodes.count)) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'generateDialCodeAPI',
      'Error due to error in count input', data.request))
    rspObj.errCode = dialCodeMessage.GENERATE.MISSING_COUNT
    rspObj.errMsg = dialCodeMessage.GENERATE.MISSING_COUNT_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }

  // Transform request for Content provider
  var reqData = {
    request: data.request
  }
  var requestedCount = _.clone(_.get(data, 'request.dialcodes.count'))
  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'generateDialCodeAPI',
        'Request to generate the dialcode', {
          body: reqData,
          headers: req.headers
        }))

      dialCodeServiceHelper.generateDialcodes(reqData, req.headers, function (err, res) {
        if (err || _.indexOf([responseCode.SUCCESS, responseCode.PARTIAL_SUCCESS], res.responseCode) === -1) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'generateDialCodeAPI', 'Getting error', res))
          rspObj.errCode = res && res.params ? res.params.err : dialCodeMessage.GENERATE.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : dialCodeMessage.GENERATE.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    }, function (res, CBW) {
      var requestObj = data && data.request && data.request.dialcodes ? data.request.dialcodes : {}
      if (requestObj.qrCodeSpec && !_.isEmpty(requestObj.qrCodeSpec) && res.result.dialcodes &&
        res.result.dialcodes.length) {
        var channel = req.get('x-channel-id')
        var batchImageService = getBatchImageInstance(requestObj)
        prepareQRCodeRequestData(res.result.dialcodes, batchImageService.config, channel, requestObj.publisher, null, function (error, data) {
          if (error) {
            LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'generateDialCodeAPI',
              'Error while creating image bacth request', error))
            res.responseCode = responseCode.PARTIAL_SUCCESS
            return response.status(207).send(respUtil.successResponse(res))
          } else {
            batchImageService.createRequest(data, channel, requestObj.publisher, rspObj,
              function (err, processId) {
                if (err) {
                  LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'generateDialCodeAPI',
                    'Error while creating image bacth request', err))
                  res.responseCode = responseCode.PARTIAL_SUCCESS
                  return response.status(207).send(respUtil.successResponse(res))
                } else {
                  res.result.processId = processId
                  CBW(null, res)
                }
              })
          }
        })
      } else {
        CBW(null, res)
      }
    },
    function (res) {
      rspObj.result = res.result
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'generateDialCodeAPI',
        'Return response back to user', rspObj))

      if (requestedCount > configUtil.getConfig('DIALCODE_GENERATE_MAX_COUNT')) {
        rspObj.responseCode = responseCode.PARTIAL_SUCCESS
        return response.status(207).send(respUtil.successResponse(rspObj))
      }
      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

/**
 * This function helps to get list of dialcodes
 * @param {type} req
 * @param {type} response
 * @returns {object} return response object with http status
 */
function dialCodeListAPI(req, response) {
  var data = req.body
  var rspObj = req.rspObj
  var qrCodeFlag = !!(data && data.request && data.request.search && data.request.search.qrCodeSpec &&
    !_.isEmpty(data.request.search.qrCodeSpec))
  if (qrCodeFlag) {
    var requestObj = data.request.search
  }

  if (!data.request || !data.request.search || !data.request.search.publisher) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'dialCodeListAPI',
      'Error due to required params are missing', data.request))
    rspObj.errCode = dialCodeMessage.LIST.MISSING_CODE
    rspObj.errMsg = dialCodeMessage.LIST.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }

  if (data.request && data.request.search) {
    data.request.search = _.omit(data.request.search, ['qrCodeSpec'])
  }
  // Transform request for Content provider
  var reqData = {
    request: data.request
  }

  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'dialCodeListAPI',
        'Request to get list of dialcode', {
          body: reqData,
          headers: req.headers
        }))
      contentProvider.dialCodeList(reqData, req.headers, function (err, res) {
        if (err || _.indexOf([responseCode.SUCCESS, responseCode.PARTIAL_SUCCESS], res.responseCode) === -1) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'dialCodeListAPI', 'Getting error', res))
          rspObj.errCode = res && res.params ? res.params.err : dialCodeMessage.LIST.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : dialCodeMessage.LIST.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    }, function (res, CBW) {
      if (qrCodeFlag && res.result.dialcodes && res.result.dialcodes.length) {
        var batchImageService = getBatchImageInstance(requestObj)
        var channel = _.clone(req.get('x-channel-id'))
        var dialcodes = _.map(res.result.dialcodes, 'identifier')
        prepareQRCodeRequestData(dialcodes, batchImageService.config, channel, requestObj.publisher, null, function (error, data) {
          if (error) {
            LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'generateDialCodeAPI',
              'Error while creating image bacth request', error))
            res.responseCode = responseCode.PARTIAL_SUCCESS
            return response.status(207).send(respUtil.successResponse(res))
          } else {
            batchImageService.createRequest(data, channel, requestObj.publisher, rspObj,
              function (err, processId) {
                if (err) {
                  LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'generateDialCodeAPI',
                    'Error while creating image bacth request', err))
                  res.responseCode = responseCode.PARTIAL_SUCCESS
                  return response.status(207).send(respUtil.successResponse(res))
                } else {
                  res.result.processId = processId
                  CBW(null, res)
                }
              })
          }
        })
      } else {
        CBW(null, res)
      }
    },
    function (res) {
      rspObj.result = res.result
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'dialCodeListAPI',
        'Return response back to user'))
      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

/**
 * This function helps to update dialcode
 * @param {type} req
 * @param {type} response
 * @returns {object} return response object with http status
 */
function updateDialCodeAPI(req, response) {
  var data = req.body
  data.dialCodeId = req.params.dialCodeId
  var rspObj = req.rspObj
  // Adding objectData in telemetryData object
  if (rspObj.telemetryData) {
    rspObj.telemetryData.object = utilsService.getObjectData(data.dialCodeId, 'dialcode', '', {})
  }

  if (!data.request || !data.request.dialcode || !data.dialCodeId) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'updateDialCodeAPI',
      'Error due to required params are missing', data.request))
    rspObj.errCode = dialCodeMessage.UPDATE.MISSING_CODE
    rspObj.errMsg = dialCodeMessage.UPDATE.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }

  // Transform request for Ek step
  var reqData = {
    request: data.request
  }

  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'updateDialCodeAPI',
        'Request to update the dialcode', {
          body: reqData,
          headers: req.headers
        }))
      contentProvider.updateDialCode(reqData, data.dialCodeId, req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'updateDialCodeAPI', 'Getting error', res))
          rspObj.errCode = res && res.params ? res.params.err : dialCodeMessage.UPDATE.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : dialCodeMessage.UPDATE.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },
    function (res) {
      rspObj.result = res.result
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'updateDialCodeAPI',
        'Return response back to user', rspObj))
      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

/**
 * This function helps to get dialcode meta
 * @param {type} req
 * @param {type} response
 * @returns {object} return response object with http status
 */
function getDialCodeAPI(req, response) {
  var data = {}
  data.body = req.body
  data.dialCodeId = _.get(req, 'body.request.dialcode.identifier')
  var rspObj = req.rspObj
  // Adding objectData in telemetryData object
  if (rspObj.telemetryData) {
    rspObj.telemetryData.object = utilsService.getObjectData(data.dialCodeId, 'dialcode', '', {})
  }

  if (!data.dialCodeId) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'getDialCodeAPI',
      'Error due to required params are missing', {
        dialCodeId: data.dialCodeId
      }))
    rspObj.errCode = dialCodeMessage.GET.MISSING_CODE
    rspObj.errMsg = dialCodeMessage.GET.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }

  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'getDialCodeAPI',
        'Request to get dialcode meta data', {
          dialCodeId: data.dialCodeId,
          qs: data.queryParams,
          headers: req.headers
        }))
      contentProvider.getDialCode(data.dialCodeId, req.headers, function (err, res) {
        // After check response, we perform other operation
        console.log(err)
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'getDialCodeAPI', 'Getting error', res))
          rspObj.errCode = res && res.params ? res.params.err : dialCodeMessage.GET.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : dialCodeMessage.GET.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },
    function (res) {
      rspObj.result = res.result
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'getDialCodeAPI',
        'Sending response back to user'))
      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

/**
 * This function helps to check content link api request data
 * @param {type} data
 * @returns {boolean} return response boolean value true or false
 */
function checkContentLinkRequest(data) {
  if (!data.request || !data.request.content || !data.request.content.identifier || !data.request.content.dialcode) {
    return false
  }
  var dialcodesLength = data.request.content.dialcode.length
  var identifiersLength = data.request.content.identifier.length
  if (dialcodesLength < 1 || identifiersLength < 1 || (dialcodesLength > 1 && identifiersLength > 1)) {
    return false
  } else {
    return true
  }
}

/**
 * This function helps to link the content with dialcode
 * @param {type} req
 * @param {type} response
 * @returns {object} return response object with http status
 */
function contentLinkDialCodeAPI(req, response) {
  var data = req.body
  var rspObj = req.rspObj

  if (!checkContentLinkRequest(data)) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'contentLinkDialCodeAPI',
      'Error due to required params are missing', data.request))
    rspObj.errCode = dialCodeMessage.CONTENT_LINK.MISSING_CODE
    rspObj.errMsg = dialCodeMessage.CONTENT_LINK.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }
  // Transform request for content provider
  var reqData = {
    request: data.request
  }

  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'contentLinkDialCodeAPI',
        'Request to link the content', {
          body: reqData,
          headers: req.headers
        }))
      contentProvider.contentLinkDialCode(reqData, req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'contentLinkDialCodeAPI',
            'Getting error', res))
          rspObj.errCode = res && res.params ? res.params.err : dialCodeMessage.CONTENT_LINK.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : dialCodeMessage.CONTENT_LINK.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },
    function (res) {
      rspObj.result = res.result
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'contentLinkDialCodeAPI',
        'Return response back to user', rspObj))
      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

/**
 * This function used to get the status of the batch dialcodes creation status with process id
 * @param {type} req
 * @param {type} response
 * @returns {object} return response object with http status
 */
function getProcessIdStatusAPI(req, response) {
  var data = {}
  data.body = req.body
  data.processId = req.params.processId
  var rspObj = req.rspObj
  // Adding objectData in telemetryData object
  if (rspObj.telemetryData) {
    rspObj.telemetryData.object = utilsService.getObjectData(data.processId, 'dialcode', '', {})
  }

  if (!data.processId) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'getDialCodeAPI',
      'Error due to required params are missing', {
        processId: data.processId
      }))
    rspObj.errCode = dialCodeMessage.PROCESS.MISSING_CODE
    rspObj.errMsg = dialCodeMessage.PROCESS.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }
  var batchImageService = new BatchImageService()
  batchImageService.getStatus(rspObj, req.params.processId).then(process => {
    return response.status(process.code).send(process.data)
  })
    .catch(err => {
      var error = JSON.parse(err.message)
      return response.status(error.code).send(error.data)
    })
}

/**
 * This function helps to search dialcode
 * @param {type} req
 * @param {type} response
 * @returns {object} return response object with http status
 */
function searchDialCodeAPI(req, response) {
  var data = req.body
  var rspObj = req.rspObj

  if (!data.request || !data.request.search) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'searchDialCodeAPI',
      'Error due to required params are missing', data.request))
    rspObj.errCode = dialCodeMessage.SEARCH.MISSING_CODE
    rspObj.errMsg = dialCodeMessage.SEARCH.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }

  // Transform request for Content provider
  var reqData = {
    request: data.request
  }

  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'searchDialCodeAPI', 'Request to search', {
        body: reqData,
        headers: req.headers
      }))
      contentProvider.searchDialCode(reqData, req.headers, function (err, res) {
        if (err || _.indexOf([responseCode.SUCCESS, responseCode.PARTIAL_SUCCESS], res.responseCode) === -1) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'searchDialCodeAPI', 'Getting error', res))
          rspObj.errCode = res && res.params ? res.params.err : dialCodeMessage.SEARCH.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : dialCodeMessage.SEARCH.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },
    function (res) {
      rspObj.result = res.result
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'searchDialCodeAPI',
        'Return response back to user', rspObj))
      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

/**
 * This function helps to publish dialcode
 * @param {type} req
 * @param {type} response
 * @returns {object} return response object with http status
 */
function publishDialCodeAPI(req, response) {
  var data = req.body
  var rspObj = req.rspObj
  data.dialCodeId = req.params.dialCodeId
  // Adding objectData in telemetryData object
  if (rspObj.telemetryData) {
    rspObj.telemetryData.object = utilsService.getObjectData(data.dialCodeId, 'dialcode', '', {})
  }

  if (!data.request || !data.dialCodeId) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'publishDialCodeAPI',
      'Error due to required params are missing', data.request))
    rspObj.errCode = dialCodeMessage.PUBLISH.MISSING_CODE
    rspObj.errMsg = dialCodeMessage.PUBLISH.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }

  // Transform request for Content provider
  var reqData = {
    request: data.request
  }

  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'publishDialCodeAPI',
        'Request to publish the dialcode', {
          body: reqData,
          headers: req.headers
        }))
      contentProvider.publishDialCode(reqData, data.dialCodeId, req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'publishDialCodeAPI', 'Getting error', res))
          rspObj.errCode = res && res.params ? res.params.err : dialCodeMessage.PUBLISH.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : dialCodeMessage.PUBLISH.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },
    function (res) {
      rspObj.result = res.result
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'publishDialCodeAPI',
        'Return response back to user', rspObj))
      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

/**
 * This function helps to create publisher
 * @param {type} req
 * @param {type} response
 * @returns {object} return response object with http status
 */
function createPublisherAPI(req, response) {
  var data = req.body
  var rspObj = req.rspObj

  if (!data.request || !data.request.publisher || !data.request.publisher.identifier || !data.request.publisher.name) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'createPublisherAPI',
      'Error due to required params are missing', data.request))
    rspObj.errCode = dialCodeMessage.CREATE_PUBLISHER.MISSING_CODE
    rspObj.errMsg = dialCodeMessage.CREATE_PUBLISHER.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }

  // Transform request for Content provider
  var reqData = {
    request: data.request
  }

  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'createPublisherAPI',
        'Request to create publisher', {
          body: reqData,
          headers: req.headers
        }))
      contentProvider.createPublisher(reqData, req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'createPublisherAPI', 'Getting error', res))
          rspObj.errCode = res && res.params ? res.params.err : dialCodeMessage.CREATE_PUBLISHER.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : dialCodeMessage.CREATE_PUBLISHER.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },
    function (res) {
      rspObj.result = res.result
      // Adding objectData in telemetryData object
      if (rspObj.telemetryData) {
        rspObj.telemetryData.object = utilsService.getObjectData(data.dialCodeId, 'dialcode', '', {})
      }
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'createPublisherAPI',
        'Return response back to user', rspObj))
      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

/**
 * This function helps to update publisher
 * @param {type} req
 * @param {type} response
 * @returns {object} return response object with http status
 */
function updatePublisherAPI(req, response) {
  var data = req.body
  data.publisherId = req.params.publisherId
  var rspObj = req.rspObj

  if (!data.request || !data.request.publisher || !data.publisherId) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'updatePublisherAPI',
      'Error due to required params are missing', data.request))
    rspObj.errCode = dialCodeMessage.UPDATE_PUBLISHER.MISSING_CODE
    rspObj.errMsg = dialCodeMessage.UPDATE_PUBLISHER.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }

  // Transform request for Content Provider
  var reqData = {
    request: data.request
  }

  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'updatePublisherAPI',
        'Request to update the publisher', {
          body: reqData,
          headers: req.headers
        }))
      contentProvider.updatePublisher(reqData, data.publisherId, req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'updatePublisherAPI', 'Getting error', res))
          rspObj.errCode = res && res.params ? res.params.err : dialCodeMessage.UPDATE_PUBLISHER.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : dialCodeMessage.UPDATE_PUBLISHER.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },
    function (res) {
      rspObj.result = res.result
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'updatePublisherAPI',
        'Return response back to user', rspObj))
      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

/**
 * This function helps to get publisher metadata
 * @param {type} req
 * @param {type} response
 * @returns {object} return response object with http status
 */
function getPublisherAPI(req, response) {
  var data = {}
  data.publisherId = req.params.publisherId
  var rspObj = req.rspObj

  if (!data.publisherId) {
    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'getPublisherAPI',
      'Error due to required params are missing', {
        dialCodeId: data.dialCodeId
      }))
    rspObj.errCode = dialCodeMessage.GET.MISSING_CODE
    rspObj.errMsg = dialCodeMessage.GET.MISSING_MESSAGE
    rspObj.responseCode = responseCode.CLIENT_ERROR
    return response.status(400).send(respUtil.errorResponse(rspObj))
  }

  async.waterfall([

    function (CBW) {
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'getPublisherAPI',
        'Request to get publisher meta data', {
          publisherId: data.publisherId,
          qs: data.queryParams,
          headers: req.headers
        }))
      contentProvider.getPublisher(data.publisherId, req.headers, function (err, res) {
        // After check response, we perform other operation
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'getPublisherAPI', 'Getting error', res))
          rspObj.errCode = res && res.params ? res.params.err : dialCodeMessage.GET.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : dialCodeMessage.GET.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.SERVER_ERROR
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          rspObj = utilsService.getErrorResponse(rspObj, res)
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },
    function (res) {
      rspObj.result = res.result
      LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename, 'getPublisherAPI',
        'Sending response back to user'))
      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

function reserveDialCode(req, response) {
  var data = req.body
  var rspObj = req.rspObj

  async.waterfall([

    function (CBW) {
      contentProvider.reserveDialcode(req.params.contentId, data, req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'reserveDialCode',
            'Error while fetching data from reserve dialcode API', 'err = ' + err + ', res = ' + res))
          rspObj.errCode = res && res.params ? res.params.err : dialCodeMessage.RESERVE.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : dialCodeMessage.RESERVE.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.CLIENT_ERROR
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          if (res && res.result) rspObj.result = res.result
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    }, function (res, CBW) {
      var requestObj = data && data.request && data.request.dialcodes ? data.request.dialcodes : {}
      if (requestObj.qrCodeSpec && !_.isEmpty(requestObj.qrCodeSpec) && res.result.reservedDialcodes &&
        res.result.reservedDialcodes.length) {
        var batchImageService = getBatchImageInstance(requestObj)
        var channel = _.clone(req.get('x-channel-id'))
        prepareQRCodeRequestData(res.result.reservedDialcodes, batchImageService.config, channel,
          requestObj.publisher, req.params.contentId, function (error, data) {
            if (error) {
              LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'reserveDialCodeAPI',
                'Error while creating image bacth request in reserveDialCodeAPI', error))
              res.responseCode = responseCode.PARTIAL_SUCCESS
              return response.status(207).send(respUtil.successResponse(res))
            } else {
              batchImageService.createRequest(data, channel, requestObj.publisher, rspObj,
                function (err, processId) {
                  if (err) {
                    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'reserveDialCodeAPI',
                      'Error while creating image bacth request in reserveDialCodeAPI', err))
                    res.responseCode = responseCode.PARTIAL_SUCCESS
                    return response.status(207).send(respUtil.successResponse(res))
                  } else {
                    res.result.processId = processId
                    CBW(null, res)
                  }
                })
            }
          })
      } else {
        CBW(null, res)
      }
    },
    function (res, CBW) {
      if (_.get(res, 'result.processId') && _.get(res, 'result.versionKey')) {
        var ekStepReqData = {
          'request': {
            'content': {
              'versionKey': _.get(res, 'result.versionKey'),
              'qrCodeProcessId': _.get(res, 'result.processId')
            }
          }
        }
        contentProvider.updateContent(ekStepReqData, req.params.contentId, req.headers, function (err, updateResponse) {
          if (err || res.responseCode !== responseCode.SUCCESS) {
            LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'reserveDialCodeAPI',
              'Getting error in update content in reserveDialCode API', 'err = ' + err + ', res = ' + updateResponse))
            rspObj.errCode = updateResponse && updateResponse.params ? updateResponse.params.err : dialCodeMessage.RESERVE.FAILED_CODE
            rspObj.errMsg = updateResponse && updateResponse.params ? updateResponse.params.errmsg : dialCodeMessage.RESERVE.FAILED_MESSAGE
            rspObj.responseCode = updateResponse && updateResponse.responseCode ? updateResponse.responseCode : responseCode.SERVER_ERROR
            var httpStatus = updateResponse && updateResponse.statusCode >= 100 && updateResponse.statusCode < 600 ? updateResponse.statusCode : 500
            rspObj = utilsService.getErrorResponse(rspObj, updateResponse)
            return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
          } else {
            if (_.get(updateResponse, 'result.versionKey')) {
              res['result']['versionKey'] = _.get(updateResponse, 'result.versionKey')
            }
            CBW(null, res)
          }
        })
      } else {
        CBW(null, res)
      }
    },
    function (res) {
      rspObj.result = res.result
      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

function releaseDialCode(req, response) {
  var data = req.body
  var rspObj = req.rspObj

  async.waterfall([

    function (CBW) {
      contentProvider.releaseDialcode(req.params.contentId, data, req.headers, function (err, res) {
        if (err || res.responseCode !== responseCode.SUCCESS) {
          LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'releaseDialCodeAPI',
            'Getting error from releaseDialCode API', 'err = ' + err + ', res = ' + res))
          rspObj.errCode = res && res.params ? res.params.err : dialCodeMessage.RELEASE.FAILED_CODE
          rspObj.errMsg = res && res.params ? res.params.errmsg : dialCodeMessage.RELEASE.FAILED_MESSAGE
          rspObj.responseCode = res && res.responseCode ? res.responseCode : responseCode.CLIENT_ERROR
          var httpStatus = res && res.statusCode >= 100 && res.statusCode < 600 ? res.statusCode : 500
          return response.status(httpStatus).send(respUtil.errorResponse(rspObj))
        } else {
          CBW(null, res)
        }
      })
    },
    function (res) {
      rspObj.result = res.result
      return response.status(200).send(respUtil.successResponse(rspObj))
    }
  ])
}

module.exports.generateDialCodeAPI = generateDialCodeAPI
module.exports.dialCodeListAPI = dialCodeListAPI
module.exports.updateDialCodeAPI = updateDialCodeAPI
module.exports.getDialCodeAPI = getDialCodeAPI
module.exports.contentLinkDialCodeAPI = contentLinkDialCodeAPI
module.exports.getProcessIdStatusAPI = getProcessIdStatusAPI
module.exports.searchDialCodeAPI = searchDialCodeAPI
module.exports.publishDialCodeAPI = publishDialCodeAPI
module.exports.createPublisherAPI = createPublisherAPI
module.exports.createPublisherAPI = createPublisherAPI
module.exports.getPublisherAPI = getPublisherAPI
module.exports.updatePublisherAPI = updatePublisherAPI
module.exports.reserveDialCode = reserveDialCode
module.exports.releaseDialCode = releaseDialCode
