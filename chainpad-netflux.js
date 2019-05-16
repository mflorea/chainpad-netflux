/*
 * Copyright 2014 XWiki SAS
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
define([
    '/bower_components/netflux-websocket/netflux-client.js'
], function (Netflux) {
    var USE_HISTORY = true;
    var module = { exports: {} };

    var verbose = function (x) { console.log(x); };
    verbose = function () {}; // comment out to enable verbose logging

    var unBencode = function (str) { return str.replace(/^\d+:/, ''); };

    var removeCp = module.exports.removeCp = function (str) {
        return str.replace(/^cp\|([A-Za-z0-9+\/=]{0,20}\|)?/, '');
    };

    module.exports.start = function (config) {
        // make sure configuration is defined
        config = config || {};

        var network = config.network;
        var websocketUrl = config.websocketURL;
        var userName = config.userName;
        var channel = config.channel;
        var Crypto = config.crypto;
        var validateKey = config.validateKey;
        var owners = config.owners;
        var password = config.password;
        var expire = config.expire;
        var readOnly = config.readOnly || false;
        var ChainPad = !config.noChainPad && (config.ChainPad || window.ChainPad);
        var useHistory = (typeof(config.useHistory) === 'undefined') ? USE_HISTORY : !!config.useHistory;
        var stopped = false;
        var lastKnownHash = config.lastKnownHash;


        var initializing = true;
        var toReturn = {};
        var realtime;
        var lastKnownHistoryKeeper;
        var historyKeeperChange = [];
        var metadata = {};

        var userList = {
            change : [],
            onChange : function(newData) {
                userList.change.forEach(function (el) {
                    el(newData);
                });
            },
            users: []
        };

        var onJoining = function(peer) {
            if (config.onJoin)  { config.onJoin(peer); }
            if(peer.length !== 32) { return; }
            var list = userList.users;
            var index = list.indexOf(peer);
            if(index === -1) {
                userList.users.push(peer);
            }
            userList.onChange();
        };

        // update UI components to show that one of the other peers has left
        var onLeaving = function(peer) {
            if (config.onLeave)  { config.onLeave(peer); }
            var list = userList.users;
            var index = list.indexOf(peer);
            if(index !== -1) {
                userList.users.splice(index, 1);
            }
            userList.onChange();
        };

        var onReady = function(wc, network) {
            // Trigger onReady only if not ready yet. This is important because the history keeper sends a direct
            // message through "network" when it is synced, and it triggers onReady for each channel joined.
            if (!initializing) { return; }

            if (realtime) { realtime.start(); }

            if(config.setMyID) {
                config.setMyID({
                    myID: wc.myID
                });
            }

            // we're fully synced
            initializing = false;

            if (config.onReady) {
                config.onReady({
                    realtime: realtime,
                    network: network,
                    userList: userList,
                    myId: wc.myID,
                    leave: wc.leave,
                    metadata: metadata
                });
            }
        };

        var onChannelError = function (err, wc) {
            if (config.onChannelError) {
                config.onChannelError({
                    channel: wc.id,
                    type: err,
                    loaded: !initializing,
                    error: err
                });
            }
            if (wc && (err === "EEXPIRED" || err === "EDELETED")) { wc.leave(); }
        };

        var onMessage = function (peer, msg, wc, network, direct) {
            // unpack the history keeper from the webchannel
            var hk = network.historyKeeper;
            var isHk = peer === hk;

            // Old server
            if (wc && (msg === 0 || msg === '0')) {
                return void onReady(wc, network);
            }
            if (direct && peer !== hk) {
                return;
            }
            if (direct) {
                var parsed = JSON.parse(msg);
                if (parsed.validateKey && parsed.channel) {
                    if (parsed.channel === wc.id && !validateKey) {
                        validateKey = parsed.validateKey;
                    }
                    if (parsed.channel === wc.id) {
                        metadata = parsed;
                    }
                    // We have to return even if it is not the current channel:
                    // we don't want to continue with other channels messages here
                    return;
                }
                if (parsed.state && parsed.state === 1 && parsed.channel) {
                    if (parsed.channel === wc.id) {
                        onReady(wc, network);
                    }
                    // We have to return even if it is not the current channel:
                    // we don't want to continue with other channels messages here
                    return;
                }
            }
            if (isHk) {
                // if the peer is the 'history keeper', extract their message
                var parsed1 = JSON.parse(msg);
                // First check if it is an error message (EXPIRED/DELETED)
                if (parsed1.channel === wc.id && parsed1.error) {
                    onChannelError(parsed1.error, wc);
                    return;
                }

                msg = parsed1[4];
                // Check that this is a message for us
                if (parsed1[3] !== wc.id) { return; }
            }

            lastKnownHash = msg.slice(0,64);

            var isCp = /^cp\|/.test(msg);
            msg = removeCp(msg);
            try {
                msg = Crypto.decrypt(msg, validateKey, isHk);
            } catch (err) {
                console.error(err);
            }

            verbose(msg);

            if (!initializing) {
                if (config.onLocal) {
                    config.onLocal(true);
                }
            }

            // slice off the bencoded header
            // Why are we getting bencoded stuff to begin with?
            // FIXME this shouldn't be necessary
            var message = unBencode(msg);//.slice(message.indexOf(':[') + 1);

            // pass the message into Chainpad
            if (realtime) { realtime.message(message); }
            if (config.onMessage) { config.onMessage(message, peer, validateKey, isCp, lastKnownHash); }
        };

        var msgOut = function(msg) {
            if (readOnly) { return; }
            try {
                var cmsg = Crypto.encrypt(msg);
                if (msg.indexOf('[4') === 0) {
                    var id = '';
                    if (window.nacl) {
                        var hash = window.nacl.hash(window.nacl.util.decodeUTF8(msg));
                        id = window.nacl.util.encodeBase64(hash.slice(0, 8)) + '|';
                    } else {
                        console.log("Checkpoint sent without an ID. Nacl is missing.");
                    }
                    cmsg = 'cp|' + id + cmsg;
                }
                return cmsg;
            } catch (err) {
                console.log(msg);
                throw err;
            }
        };

        var createRealtime = function() {
            return ChainPad.create({
                userName: userName,
                initialState: config.initialState,
                transformFunction: config.transformFunction,
                patchTransformer: config.patchTransformer,
                validateContent: config.validateContent,
                avgSyncMilliseconds: config.avgSyncMilliseconds,
                logLevel: typeof(config.logLevel) !== 'undefined'? config.logLevel : 1
            });
        };

        // We use an object to store the webchannel so that we don't have to push new handlers to chainpad
        // and remove the old ones when reconnecting and keeping the same 'realtime' object
        // See realtime.onMessage below: we call wc.bcast(...) but wc may change
        var wcObject = {};
        var onOpen = function(wc, network, firstConnection) {
            wcObject.wc = wc;
            channel = wc.id;

            // Add the existing peers in the userList
            wc.members.forEach(onJoining);

            // Add the handlers to the WebChannel
            wc.on('message', function (msg, sender) { //Channel msg
                onMessage(sender, msg, wc, network);
            });
            wc.on('join', onJoining);
            wc.on('leave', onLeaving);

            if (firstConnection) {
                wcObject.send = function (message, cb) {
                    // Filter messages sent by Chainpad to make it compatible with Netflux
                    message = msgOut(message);
                    if(message) {
                        wcObject.wc.bcast(message).then(function() {
                            var hash = message.slice(0, 64);
                            cb(null, hash);
                        }, function(err) {
                            // The message has not been sent, display the error.
                            // TODO check if we can "cb(err);" in chainpad
                            console.error(err);
                        });
                    }
                };

                if (ChainPad) {
                    toReturn.realtime = realtime = createRealtime();

                    realtime._patch = realtime.patch;
                    realtime.patch = function (patch, x, y) {
                        if (initializing) {
                            console.error("attempted to change the content before chainpad was synced");
                        }
                        return realtime._patch(patch, x, y);
                    };
                    realtime._change = realtime.change;
                    realtime.change = function (offset, count, chars) {
                        if (initializing) {
                            console.error("attempted to change the content before chainpad was synced");
                        }
                        return realtime._change(offset, count, chars);
                    };

                    // Sending a message...
                    realtime.onMessage(wcObject.send);

                    realtime.onPatch(function () {
                        if (config.onRemote) {
                            config.onRemote({
                                realtime: realtime
                            });
                        }
                    });
                }

                if (config.onInit) {
                    config.onInit({
                        myID: wc.myID,
                        realtime: realtime,
                        getLag: network.getLag,
                        userList: userList,
                        network: network,
                        channel: channel,
                    });
                }
            }

            if (config.onConnect) {
                config.onConnect(wc, wcObject.send);
            }

            // Get the channel history
            if (useHistory) {
                var hk;

                wc.members.forEach(function (p) {
                    if (p.length === 16) { hk = p; }
                });
                if (lastKnownHistoryKeeper !== hk) {
                    network.historyKeeper = hk;
                    lastKnownHistoryKeeper = hk;
                    historyKeeperChange.forEach(function (f) {
                        f(hk);
                    });
                }

                // Add the validateKey if we are the channel creator and we have a validateKey
                var cfg = {
                    validateKey: validateKey,
                    lastKnownHash: lastKnownHash,
                    owners: owners,
                    expire: expire,
                    password: password
                };
                var msg = ['GET_HISTORY', wc.id, cfg];
                if (hk) { network.sendto(hk, JSON.stringify(msg)); }
            } else {
                onReady(wc, network);
            }
        };

        // Set a flag to avoid calling onAbort or onConnectionChange when the user is leaving the page
        var isIntentionallyLeaving = false;
        window.addEventListener("beforeunload", function () {
            isIntentionallyLeaving = true;
        });

        var findChannelById = function(webChannels, channelId) {
            var webChannel;

            // Array.some terminates once a truthy value is returned
            // best case is faster than forEach, though webchannel arrays seem
            // to consistently have a length of 1
            webChannels.some(function(chan) {
                if(chan.id === channelId) { webChannel = chan; return true;}
            });
            return webChannel;
        };

        var onConnectError = function (err) {
            if (config.onError) {
                config.onError({
                    type: err && (err.type || err),
                    error: err.type,
                    loaded: !initializing
                });
            }
        };

        var joinSession = function (endPoint, cb) {
            // a websocket URL has been provided
            // connect to it with Netflux.
            if (typeof(endPoint) === 'string') {
                Netflux.connect(endPoint).then(cb, onConnectError);
            } else if (typeof(endPoint.then) === 'function') {
                // a netflux network promise was provided
                // connect to it and use a channel
                endPoint.then(cb, onConnectError);
            } else {
                // assume it's a network and try to connect.
                cb(endPoint);
            }
        };

        var firstConnection = true;
        /*  Connect to the Netflux network, or fall back to a WebSocket
            in theory this lets us connect to more netflux channels using only
            one network. */
        var connectTo = function (network, first) {
            // join the netflux network, promise to handle opening of the channel
            network.join(channel || null).then(function(wc) {
                onOpen(wc, network, first);
            }, function(error) {
                console.error(error);
                onConnectError(error);
            });
        };

        joinSession(network || websocketUrl, function (network) {
            // pass messages that come out of netflux into our local handler
            if (firstConnection) {
                firstConnection = false;

                toReturn.network = network;
                toReturn.stop = function () {
                    var wchan = findChannelById(network.webChannels, channel);
                    if (wchan) { wchan.leave(''); }
                    stopped = true;
                };

                network.onHistoryKeeperChange = function (todo) {
                    historyKeeperChange.push(todo);
                };

                network.on('disconnect', function (reason) {
                    if (isIntentionallyLeaving) { return; }
                    if (reason === "network.disconnect() called") { return; }
                    if (config.onConnectionChange) {
                        config.onConnectionChange({
                            state: false
                        });
                        return;
                    }
                    if (config.onAbort) {
                        config.onAbort({
                            reason: reason
                        });
                    }
                });

                network.on('reconnect', function (uid) {
                    if (stopped) { return; }
                    if (config.onConnectionChange) {
                        config.onConnectionChange({
                            state: true,
                            myId: uid
                        });
                        var afterReconnecting = function () {
                            initializing = true;
                            userList.users=[];
                            joinSession(network, connectTo);
                        };
                        if (config.beforeReconnecting) {
                            config.beforeReconnecting(function (newKey, newContent) {
                                channel = newKey;
                                config.initialState = newContent;
                                afterReconnecting();
                            });
                            return;
                        }
                        afterReconnecting();
                    }
                });

                network.on('message', function (msg, sender) { // Direct message
                    if (stopped) { return; }
                    var wchan = findChannelById(network.webChannels, channel);
                    if(wchan) {
                        onMessage(sender, msg, wchan, network, true);
                    }
                });
            }

            connectTo(network, true);
        });

        toReturn.stop = function () { stopped = true; };

        return toReturn;
    };
    return module.exports;
});
