// Copyright 2016 the project authors as listed in the AUTHORS file.
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
  return { 'title': 'MqttDlnaPlay' };
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

var mediaPlayerUrl = new Array();
const updateMediaPlayer = function(config) {
  // if default URLs are specified use them
  for (var index = 0; index < config.mediaPlayer.length; index++) {
    if (config.mediaPlayer[index].defaultURL !== undefined) {
       mediaPlayerUrl[index] = config.mediaPlayer[index].defaultURL;
    }
  }

  // scan for any other media plauers
  getMediaPlayers(config, function(err, index, result) {
    if (!err) {
      if (result !== mediaPlayerUrl[index]) {
        mediaPlayerUrl[index] = result;
        pushActivity('New Media Player Url:' + mediaPlayerUrl[index]);
      }
    }
  });
}

const getMediaPlayers = function(config, callback) {
  let done = false;
  node_ssdp_client.on('response', function (headers, statusCode, rinfo) {

    // get the description for the device to see if it matches the one
    // requested
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
          for (var index = 0; index < config.mediaPlayer.length; index++) {
            const candiatePlayer = config.mediaPlayer[index];
            if (result != null) {
              console.log('Candidate Name:' + result.root.device[0].friendlyName.toString());
              console.log('Candidate UDN:' + result.root.device[0].UDN.toString());
              if ( !err &&
                   (result.root.device[0].friendlyName.toString().startsWith(candiatePlayer.name)) &&
                   ((candiatePlayer.UDN == undefined) ||
                    (candiatePlayer.UDN === result.root.device[0].UDN.toString())
                   )
              ) {
                done = true;
                callback(undefined, index, headers.LOCATION);
                break;
              };
            };
          }
        });
      });
    });
    req.on('error', function(err) {
      callback(err);
    });
    req.end();
  });
  // search for the media player
  node_ssdp_client.search('urn:schemas-upnp-org:device:MediaRenderer:1');
}


const searchServer = function(serverName,
                              serverSearchRoot,
                              filter,
                              callback) {
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
          if ((result != null) && (result.root.device[0].friendlyName.toString() === serverName)) {
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
                filter(result, callback);
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
  // search for media server and then return the results for the requested search
  node_ssdp_client.search('urn:schemas-upnp-org:device:MediaServer:1');
};

Server.startServer = function(server) {
  eventSocket = socketio.listen(server);

  if (!Server.config.newDays) {
    Server.config.newDays = 7;
  }

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


  var playerClient = new Array();
  mqttClient.on('message', function(topic, message) {
    pushActivity(topic + ':' + message.toString());
    var rendererId = message.toString().split(",")[1];
    if (rendererId === undefined) {
      rendererId = 0;
      message = message.toString();
    } else {
      message = message.toString().split(",")[0];
    }

    var timeout = 0;
    if (!mediaPlayerUrl[rendererId]) {
      updateMediaPlayer(Server.config);
      timeout = 1000;
    }

    setTimeout(function () {
      playerClient[rendererId] = new MediaRendererClient(mediaPlayerUrl[rendererId]);
      if (topic.endsWith('/play')) {
        playVideo(rendererId, message);
      } else if (topic.endsWith('/control')) {
        message = message.toString();
        if (message === 'stop') {
          playerClient[rendererId].stop();
        } else if (message === 'pause') {
          playerClient[rendererId].pause();
        } else if (message === 'play') {
          playerClient[rendererId].play();
        } else if (message.startsWith('seek')) {
          const time = message.split(":")[1];
          playerClient[rendererId].seek(time * 60);
        } else if (message === 'whatsnew') {
          whatsNew();
        }
      }
    }, timeout);
  });

  var playVideo = function(rendererId, message) {
    searchServer(
      Server.config.dlnaServerName,
      Server.config.dlnaSearchRoot,
      function(result, callback) {
        // right now we only support searching in a specific directory
        // so just look at the items
        const requestedName = message.toString().toLowerCase().replace(/ /g, '_').replace(/'/g, '');
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
                    (month > currentDate.getMonth())) {
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
      },
      function(err, result) {
        if (result) {
          if (err) {
            console.log(err);
            pushActivity('failed during media search:' + result.title);
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

          // Older TV accepted format being returned. New TV
          // was stricter. Adjust content type to match.
          // New value works on both TVs
          options.contentType = options.contentType.replace('http-get:*:', '').replace(':*');

          playerClient[rendererId].stop();
          setTimeout(function() {
            console.log('about to play:' + result.res);
            playerClient[rendererId].load(result.res, options, function(err) {
              if (err) {
                // in case the media player has changed ip/port since we
                // started do an update
                updateMediaPlayer(Server.config);

                // send response back to requestor
                mqttClient.publish(responseTopic, 'failed to play media:');
                pushActivity('failed to play media:' + result.title + 'err:' + err);
              } else {
                // send response back to requestor
                mqttClient.publish(responseTopic, 'playing');
                pushActivity('playing ...:' + result.title);
              }
            });
          }, 1000);
        } else {
          // send response back with an error
          pushActivity('No current episodes for:' + message.toString());
          mqttClient.publish(responseTopic, 'No current episodes for ' + message.toString() );
        }
      }
    );
  };

  var whatsNew = function(message) {
    searchServer(
      Server.config.dlnaServerName,
      Server.config.dlnaSearchRoot,
      function(result, callback) {
        // right now we only support searching in a specific directory
        // so just look at the items
        var newThisWeekList = new Object();
        var currentDate = new Date();
        if (result.item) {
          for (let i = 0; i < result.item.length; i++) {
            try {
              const titleName = result.item[i].title.toLowerCase();
              const seriesandtime = titleName.split('-')[0];
              const series = seriesandtime.substr(0,seriesandtime.length - 8)
              const date = seriesandtime.substr(seriesandtime.length - 8);
              const month = parseInt(date.substr(0,2)) -1;
              const day = date.substr(2,2);
              const hour = date.substr(4,2);
              const minute = date.substr(6,2);
              var year = parseInt(currentDate.getFullYear());
              if (((currentDate.getMonth() == month) && (currentDate.getDate() < day)) ||
                  (month > currentDate.getMonth())) {
                year = year -1;
              }
              const titleDate = new Date(year, month, day, hour, minute, 0, 0);
              if (titleDate.getTime() >
                  (currentDate.getTime() - (Server.config.newDays * 24 * 60 *60 *1000))) {
                if(!newThisWeekList[series]) {
                  if ((Server.config.ignore === undefined) || (Server.config.ignore.indexOf(series) === -1)) {
                    newThisWeekList[series] = true;
                  }
                }
              }
            } catch (e) {
              console.log(e);
              // invalid file name formatting just ingore
            }
          }
          callback(undefined, newThisWeekList);
        };
      },
      function(err, result) {
        if (result) {
          if (err) {
            console.log(err);
            pushActivity('failed during media search:' + result.title);
            mqttClient.publish(responseTopic, 'failed during media search');
            return;
          }

          var newEpisodes = new Array();
          for (var series in result) {
            if (result.hasOwnProperty(series)) {
              newEpisodes.push(series.replace(/_/g, ' '));
            }
          }
          // send response back with an error
          var response = 'No new episodes this week';
          if (newEpisodes.length > 0) {
            response = 'New episodes include: ' + newEpisodes.join(',');
          }
          pushActivity(response);
          mqttClient.publish(responseTopic, response );
        }
      }
    );
  };


  // find the media player to send content to
  updateMediaPlayer(Server.config);
}

if (require.main === module) {
  var path = require('path');
  var microAppFramework = require('micro-app-framework');
  microAppFramework(path.join(__dirname), Server);
}

module.exports = Server;
