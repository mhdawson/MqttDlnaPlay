// Copyright 2015-2016 the project authors as listed in the AUTHORS file.
// All rights reserved. Use of this source code is governed by the
// license that can be found in the LICENSE file.
"use strict";
const url = require('url');
const http = require('http');
const socketio = require('socket.io');
const mqtt = require('mqtt');
const xmltojs = require('xml2js');
const nodessdp = require('node-ssdp').Client;
const node_ssdp_client = new nodessdp();
const browseServer = require('dlna-browser-utils');
const MediaRendererClient = require('upnp-mediarenderer-client');

const PAGE_WIDTH = 400;
const PAGE_HEIGHT = 200;

var eventSocket = null;

var Server = function() {
}


Server.getDefaults = function() {
  return { 'title': 'mqtt - X10 bridge' };
}


var replacements;
Server.getTemplateReplacments = function() {
  if (replacements === undefined) {
    var config = Server.config;

    replacements = [{ 'key': '<DASHBOARD_TITLE>', 'value': Server.config.title },
    { 'key': '<UNIQUE_WINDOW_ID>', 'value': Server.config.title },
    { 'key': '<PAGE_WIDTH>', 'value': PAGE_WIDTH },
    { 'key': '<PAGE_HEIGHT>', 'value': PAGE_HEIGHT }];

  }
  return replacements;
}


var recentActivity = new Array()
var pushActivity = function(entry) {
  var newEntry = new Date() + ':' + entry;
  recentActivity.push(newEntry);
  console.log(newEntry);
  eventSocket.emit('recent_activity', newEntry);
  if (recentActivity.length > Server.config.MaxRecentActivity) {
    recentActivity.splice(0,1);
  }
}

const searchServer = function(requestedName, serverName, serverSearchRoot, callback){
  requestedName = requestedName.toLowerCase().replace(/ /g, '_');
  var done = false;
  node_ssdp_client.on('response', function (headers, statusCode, rinfo) {
    const requestUrl = url.parse(headers.LOCATION);

    const httpOptions =  {
      host: requestUrl.hostname,
      port: requestUrl.port,
      path: requestUrl.pathname
    }

    const req = http.request(httpOptions, function(response) {
      var data = ''
      response.on('data', function(newData) {
        data = data + newData;
      });

      response.on('end', function() {
        if (done == true) {
          return;
        }
        xmltojs.parseString(data, function(err, result) {
          if (result.root.device[0].friendlyName.toString() === serverName) {
            done = true;
            if (result.root.device[0].serviceList[0].service[0].serviceType[0] ===
              'urn:schemas-upnp-org:service:ContentDirectory:1') {
              const controlUrl =
              'http://' +
              requestUrl.hostname +
              ':' +
              requestUrl.port +
              result.root.device[0].serviceList[0].service[0].controlURL[0];

              browseServer(serverSearchRoot, controlUrl, {}, function(err, result) {
                if (err) {
                  callback(err);
                  return;
                }

                // right now we only support searching in a specific directory
                // so just look at the items
                var match = undefined;
                var matchTime;
                if (result.item) {
                  for (let i = 0; i < result.item.length; i++) {
                    try {
                      const titleName = result.item[i].title.toLowerCase();
                      if(titleName.indexOf(requestedName) !== -1) {
                        const seriesandtime = titleName.split('-')[0];
                        const date = seriesandtime.substr(seriesandtime.length - 8);
                        const month = parseInt(date.substr(0,2)) -1;
                        const day = date.substr(2,2);
                        const hour = date.substr(4,2);
                        const minute = date.substr(6,2);
                        const currentDate = new Date();
                        var year = parseInt(currentDate.getFullYear());
                        if (((currentDate.getMonth() == month) && (currentDate.getDate() < day)) ||
                        (month > currentDate.getMonth)) {
                          year = year -1;
                        }
                        const titleDate = new Date(year, month, day, hour, minute, 0, 0);
                        if (!match) {
                          match = result.item[i];
                          matchTime = titleDate;
                        } else if (titleDate < matchTime) {
                          match = result.item[i];
                          matchTime = titleDate;
                        }
                      }
                    } catch (e) {
                      // invalid file name formatting just ingore
                    }
                  }
                  callback(undefined, match);
                };
              });
            };
          };
        });
      });
    });
    req.on('error', function(err) {
      callback(err);
    });
    req.end();
  });
  // search for media server and display top level content
  node_ssdp_client.search('urn:schemas-upnp-org:device:MediaServer:1');
};

Server.startServer = function(server) {
  eventSocket = socketio.listen(server);

  eventSocket.on('connection', function(client) {
    for (var i = 0; i < recentActivity.length; i++) {
      eventSocket.to(client.id).emit('recent_activity', recentActivity[i]);
    }
  });

  // setup mqtt
  var mqttOptions;
  if (Server.config.mqttServerUrl.indexOf('mqtts') > -1) {
    mqttOptions = { key: fs.readFileSync(path.join(__dirname, 'mqttclient', '/client.key')),
    cert: fs.readFileSync(path.join(__dirname, 'mqttclient', '/client.cert')),
    ca: fs.readFileSync(path.join(__dirname, 'mqttclient', '/ca.cert')),
    checkServerIdentity: function() { return undefined } }
  }

  var mqttClient = mqtt.connect(Server.config.mqttServerUrl, mqttOptions);
  const responseTopic = Server.config.topic + '/response';
  mqttClient.on('connect', function() {
    mqttClient.subscribe(Server.config.topic);
    mqttClient.subscribe(Server.config.topic + '/play');
    mqttClient.subscribe(Server.config.topic + '/control');
  });


  var playerClient;
  mqttClient.on('message', function(topic, message) {
    playerClient = new MediaRendererClient('http://10.1.1.28:52235/dmr/SamsungMRDesc.xml');
    if (topic.endsWith('/play')) {
      playVideo(message);
    } else if (topic.endsWith('/control')) {
      message = message.toString();
      if (message === 'stop') {
        playerClient.stop();
      } else if (message === 'pause') {
        playerClient.pause();
      } else if (message === 'play') {
        playerClient.play();
      } else if (message.startsWith('seek')) {
        const time = message.split(":")[1];
        playerClient.seek(time * 60);
      }
    }
  });

  var playVideo = function(message) {
    searchServer(message.toString(),
      Server.config.dlnaServerName,
      Server.config.dlnaSearchRoot,
      function(err, result) {
        if (result) {
          if (err) {
            console.log(err);
            mqttClient.publish(responseTopic, 'failed during media search');
            return;
          }
          const options = {
            autoplay: true,
            contentType: result.contentType,
            metadata: {
              title: result.title,
              type: 'video',
            }
          };

          playerClient.stop();
          setTimeout(function() {
            console.log('about to play:' + result.res);
            playerClient.load(result.res, options, function(err) {
              if(err) {
                // change these to publish back to topic
                mqttClient.publish(responseTopic, 'failed to play media');
                console.log('failed to play:' + result.res);
              } else {
                // change these to publish back to topic
                mqttClient.publish(responseTopic, 'playing');
                console.log('playing ...');
              }
            });
          }, 1000);
        } else {
          // send response back with an error
          mqttClient.publish(responseTopic, 'No current episodes for ' + message.toString() );
        }
    });
  };
}

if (require.main === module) {
  var path = require('path');
  var microAppFramework = require('micro-app-framework');
  microAppFramework(path.join(__dirname), Server);
}

module.exports = Server;
