"use strict";
// SNSAdapter
//
// Uses SNS for push notification
const Parse = require('parse/node').Parse;
const GCM = require('parse-server-push-adapter').GCM;
const APNS = require('parse-server-push-adapter').APNS;
const AWS = require('aws-sdk');
const log = require('npmlog');

const LOG_PREFIX = 'parse-server-sns-adapter';

const DEFAULT_REGION = "us-east-1";
const utils = require('parse-server-push-adapter').utils;

function SNSPushAdapter(pushConfig) {
    this.validPushTypes = ['ios', 'android'];
    this.availablePushTypes = [];
    this.snsConfig = pushConfig.pushTypes;
    this.senderMap = {};

    if (!pushConfig.accessKey || !pushConfig.secretKey) {
        throw new Parse.Error(Parse.Error.PUSH_MISCONFIGURED,
            'Need to provide AWS keys');
    }

    if (pushConfig.pushTypes) {
        let pushTypes = Object.keys(pushConfig.pushTypes);
        for (let pushType of pushTypes) {
            if (this.validPushTypes.indexOf(pushType) < 0) {
                throw new Parse.Error(Parse.Error.PUSH_MISCONFIGURED,
                    'Push to ' + pushTypes + ' is not supported');
            }
            this.availablePushTypes.push(pushType);
            switch (pushType) {
                case 'ios':
                    this.senderMap[pushType] = this.sendToAPNS.bind(this);
                    break;
                case 'android':
                    this.senderMap[pushType] = this.sendToGCM.bind(this);
                    break;
            }
        }
    }

    AWS.config.update({
        accessKeyId: pushConfig.accessKey,
        secretAccessKey: pushConfig.secretKey,
        region: pushConfig.region || DEFAULT_REGION
    });

    // Instantiate after config is setup.
    this.sns = new AWS.SNS();
}


SNSPushAdapter.prototype.getValidPushTypes = function () {
    return this.availablePushTypes;
}

SNSPushAdapter.classifyInstallations = function (installations, validTypes) {
    return utils.classifyInstallations(installations, validTypes)
}

SNSPushAdapter.generateiOSPayload = function (data, production) {
    var prefix = "";

    if (production) {
        prefix = "APNS";
    } else {
        prefix = "APNS_SANDBOX"
    }

    var notification = APNS.generateNotification(data.data, data.expirationTime);

    var payload = {};
    payload[prefix] = notification.compile();
    payload["default"] = "sns";
    return payload;
}

SNSPushAdapter.generateAndroidPayload = function (data, pushId, timeStamp) {
    var pushId = pushId || utils.randomString(10);
    timeStamp = timeStamp || Date.now();
    var payload = GCM.generateGCMPayload(data.data, pushId, timeStamp, data.expirationTime);
    payload["default"] = "sns";
    
    // SNS is verify sensitive to the body being JSON stringified but not GCM key.
    return {
        'GCM': JSON.stringify(payload)
    };
}

SNSPushAdapter.prototype.sendToAPNS = function (data, devices) {

    var iosPushConfig = this.snsConfig['ios'];

    let iosConfigs = [];
    if (Array.isArray(iosPushConfig)) {
        iosConfigs = iosConfigs.concat(iosPushConfig);
    } else {
        iosConfigs.push(iosPushConfig)
    }

    let promises = [];

    for (let iosConfig of iosConfigs) {

        let production = iosConfig.production || false;
        var payload = SNSPushAdapter.generateiOSPayload(data, production);

        var deviceSends = [];
        for (let device of devices) {

            // Follow the same logic as APNS service.  If no appIdentifier, send it!
            if (!device.appIdentifier || device.appIdentifier === '') {
                deviceSends.push(device);
            }

            else if (device.appIdentifier === iosConfig.bundleId) {
                deviceSends.push(device);
            }
        }
        if (deviceSends.length > 0) {
            promises.push(this.sendToSNS(payload, deviceSends, iosConfig.ARN));
        }
    }

    return promises;
}

SNSPushAdapter.prototype.sendToGCM = function (data, devices) {
    var payload = SNSPushAdapter.generateAndroidPayload(data);
    var pushConfig = this.snsConfig['android'];

    return this.sendToSNS(payload, devices, pushConfig.ARN);
}

// Exchange the device token for the Amazon resource ID

SNSPushAdapter.prototype.sendToSNS = function (payload, devices, platformArn) {

    let exchangePromises = devices.map((device) => {
        return this.exchangeTokenPromise(device, platformArn);
    });

    // Publish off to SNS!
    // Bulk publishing is not yet supported on Amazon SNS.
    let promises = Parse.Promise.when(exchangePromises).then(exchangeResponses => {
        exchangeResponses.map((exchangeResponse) => {
            return this.sendSNSPayload(exchangeResponse.arn, payload, exchangeResponse.device);
        });
    });

    return promises;
}

/**
 * Request a Amazon Resource Identifier if one is not set.
 */

SNSPushAdapter.prototype.getPlatformArn = function (device, arn, callback) {
    var params = {
        PlatformApplicationArn: arn,
        Token: device.deviceToken
    };

    this.sns.createPlatformEndpoint(params, callback);
}

/**
 * Exchange the device token for an ARN
 */
SNSPushAdapter.prototype.exchangeTokenPromise = function (device, platformARN) {
    return new Parse.Promise((resolve, reject) => {
        
        if (device.deviceToken.startsWith("arn")) {
            return resolve({device: device, arn: device.topicArn});
        }

        this.getPlatformArn(device, platformARN, (err, data) => {
            if (data != null && data.EndpointArn) {
                resolve({device: device, arn: data.EndpointArn});
            }
            else
            {
                log.error(LOG_PREFIX, err);
                reject(err);
            }
        });
    });
}

/**
 * Send the Message, MessageStructure, and Target Amazon Resource Number (ARN) to SNS
 * @param arn Amazon Resource ID
 * @param payload JSON-encoded message
 * @returns {Parse.Promise}
 */
SNSPushAdapter.prototype.sendSNSPayload = function (arn, payload, device) {

    var object = {
        Message: JSON.stringify(payload),
        MessageStructure: 'json',
        TargetArn: arn
    };
    
    if (device.deviceToken.startsWith("arn")) {
        object.TargetArn = undefined;
        object.TopicArn = device.deviceToken;
    }

    return new Parse.Promise((resolve, reject) => {
        var response = {
            device: {
                deviceType: device.deviceType,
                deviceToken: device.deviceToken.toString('hex')
            }
        };

        // publish to topic
        if (object.TopicArn) {
            return this.sns.publish(object, (err, data) => {
                if (err != null) {
                    log.error(LOG_PREFIX, "Error sending push " + err);
                    response.transmitted = false;
                    if (err.stack) {
                        response.response = err.stack;
                    }
                    return reject(response);
                }

                if (data && data.MessageId) {
                    log.verbose(LOG_PREFIX, "Successfully sent push to " + data.MessageId);
                }

                response.transmitted = true;
                response.response = data;
                resolve(response);
            });
        }
        
        /*
         * Amazon SNS will set Endpoint to false when a notification service indicates to Amazon SNS 
         * that the endpoint is invalid. We need to set it back to true
        */
        
        var params = {
            Attributes: {
                Enabled: "true",
            },
            EndpointArn: arn
        };
        
        this.sns.setEndpointAttributes(params, (err, data) => {
            if (err != null) {
                log.error(LOG_PREFIX, "Error enabling Endpoints " + err);
                response.transmitted = false;
                if (err.stack) {
                    response.response = err.stack;
                }
                return reject(response);
            }
            
            // send the push after re-enabling Endpoint
            if (data) {
                this.sns.publish(object, (err, data) => {
                    if (err != null) {
                        log.error(LOG_PREFIX, "Error sending push " + err);
                        response.transmitted = false;
                        if (err.stack) {
                            response.response = err.stack;
                        }
                        return reject(response);
                    }

                    if (data && data.MessageId) {
                        log.verbose(LOG_PREFIX, "Successfully sent push to " + data.MessageId);
                    }

                    response.transmitted = true;
                    response.response = data;
                    resolve(response);
                });
            }
        });
    });
}

/* For a given config object, endpoint and payload, publish via SNS
 * Returns a promise containing the SNS object publish response
 */

SNSPushAdapter.prototype.send = function (data, installations) {
    if(installations.arn){
        installations = installations.arn;
        for (let installation of installations){
            installation.deviceToken = installation.topicArn;
        }
    }
    let deviceMap = utils.classifyInstallations(installations, this.availablePushTypes);

    let sendPromises = Object.keys(deviceMap).forEach((pushType) => {
        var devices = deviceMap[pushType];

        var sender = this.senderMap[pushType];
        return sender(data, devices);
    });

    return Parse.Promise.when(sendPromises);
}

module.exports = SNSPushAdapter;
module.exports.default = SNSPushAdapter;
