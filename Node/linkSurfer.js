var util = require('util');
var https = require('https');
var http = require('http');
var express = require('express');
var dbconfig = require('./dbconfig');
var io = require('socket.io');
var fs = require('fs');
var mysql = require('mysql');

const URL_REGEX = /(http:|https:)\/\/[a-zA-Z0-9._#\/;&-]+/g;

var serverStart = getCurrentTimestamp();
var linksFound = 0;
var linksScannedCount = 0;
var linkQueueCount = 0;
var serverState = "idle";

var linkQueue = [];
var lastLink = false;
var linksAddedInBatch = 0;

var lastPreview = false;

var progressLog = [];
var serverCoolDownTime = 5;
var bannedExtensions = ".js.css.asp.xml";

//Socket.IO
var socketServer = false;
var serverOptions = {
    "port": 9000,
    "key": "./privkey.pem",
    "cert": "./fullchain.pem",
    "domain": "<domain>"
}
var serverClients = [];

//MySQL
var db_config = {
    host     : dbconfig.host,
    user     : dbconfig.user,
    password : dbconfig.password,
    database : dbconfig.database,
};
var sqlConnected = false;
var connection;
var firstConnection = true;
var sqlQueue = new Array();

handleDisconnect();

function onInitialization() {
    setupSocketServer(serverOptions, function(server) {
        socketServer = server;

        logMessage("SocketIO HTTPS Listening on "+serverOptions.port+".");

        //Socket Server
        socketServer.on('connection', function(socket) {
            onSocketConnect(socket);

            socket.on('disconnect',function(data) {
                onSocketDisconnect(socket);
            });

            socket.on('identify',function(data) {
                onSocketIdentify(socket, data);
            });

            socket.on('scan',function(data) {
                onSocketSuggestScan(socket, data);
            });
        });
    });

    updateStats();

    logMessage("Attempting to start processing URLs..");
    processURLQueue();
}

function setupSocketServer(options, callback) {
    //SocketIO
    var app = express();
    var httpsServer = https.createServer({key: fs.readFileSync(options.key), cert: fs.readFileSync(options.cert)}, app);
    var ioServer = new io.Server(httpsServer, {cors: {origin: options.domain }});
    httpsServer.listen(options.port);
    callback(ioServer);
}

function onSocketConnect(socket) {
    addClient(socket);
    id = getClientIdBySocketId(socket.id);
    ip = socket.request.connection.remoteAddress;

    logMessage("[ID "+id+"] Client Connected from "+ip+".");
    socket.emit("welcome", {"id": id, "ip": ip});
    socket.emit("preview", lastPreview);
    broadcastStatusUpdate();
}

function onSocketDisconnect(socket) {
    id = getClientIdBySocketId(socket.id);
    ip = getClientParam(id, "ip");

    logMessage("[ID "+id+"] Client Disconnected from "+ip+".");
    broadcastStatusUpdate();
    removeClient(socket);
}

function onSocketIdentify(socket, data) {
    id = getClientIdBySocketId(socket.id);
    ip = getClientParam(id, "ip");

    if (id == data.id && ip == socket.request.connection.remoteAddress) {
        setClientParam(id, "authed", true);
        logMessage("[ID "+id+"] Client Identified from "+ip+".");
        broadcastStatusUpdate();
    }
}

function onSocketSuggestScan(socket, data) {
    id = getClientIdBySocketId(socket.id);
    ip = getClientParam(id, "ip");

    if (getClientParam(id, "authed") === true) {
        logMessage("[ID "+id+"] Client from "+ip+" suggested scan on "+data.url+".");
        broadcastStatusUpdate();
        suggestScanURL(data.url);
    }
}

function broadcastStatusUpdate() {
    if (socketServer !== false) {
        socketServer.emit("status", {"serverStart": serverStart, "linksScanned":linksScannedCount, "serverState":serverState, "queueSize":linkQueueCount, "progressLog":progressLog});
    }
}

function addClient(socket) {
    var client = {};
    client.socketId = socket.id;
    client.authed = false;
    client.ip = socket.request.connection.remoteAddress;
    serverClients.push(client);
}

function removeClient(socket) {
    for (var i=0; i<serverClients.length; i++) {
        if (serverClients[i].socketId == socket.id) {
            serverClients.splice(i,1);
            return true;
        }
    }
    return false;
}

function setClientParam(clientId, key, value) {
    serverClients[clientId][key] = value;
}

function getClientParam(clientId, key) {
    return serverClients[clientId][key];
}

function getClientBySocketId(socketId) {
    for (var i=0; i<serverClients.length; i++) {
        if (serverClients[i].socketId == socketId) {
            return serverClients[i];
        }
    }
    return false;
}

function getClientIdBySocketId(socketId) {
    for (var i=0; i<serverClients.length; i++) {
        if (serverClients[i].socketId == socketId) {
            return i;
        }
    }
    return false;
}

//LinkSurfer
function suggestScanURL(url) {
    if (serverState == "idle") {
        link = {};
        link.url = url;
        link.srcid = false;
        link.srcorigin = "U";
        link.srcurl = false;

        addLinkToQueue(link, function(result) {
            if (result) {
                processURLQueue();
            }
        });
    }
}

function addLinkToQueue(link, callback) {
    query = "SELECT * FROM links WHERE LINKURL = '"+link.url+"'";
    mysql_query(query, function(rows, fields, err) {
        if (err) {
            logMessage("addLinkToQueue Query A Failure:"+err);
            callback(false);
        }
        else {
            if (rows.length == 0) {
                query = "INSERT INTO links (LINKURL, SOURCELINKID, SOURCEURL, SOURCEORIGIN, ADDED, SCANNED) VALUES ('"+link.url+"', "+(link.srcid != false?"'"+link.srcid+"'":"NULL")+", "+(link.srcurl != false?"'"+link.srcurl+"'":"NULL")+",'"+link.srcorigin+"', SYSDATE(), 'N')";
                mysql_query(query, function(rows, fields, err) {
                    if (err) {
                        logMessage("addLinkToQueue Query B Failure:"+err);
                        console.log(query);
                        callback(false);
                    }
                    else {
                        callback(true);
                    }
                });
            }
            else {
                callback(false);
            }
        }
    });
}

function processURLQueue() {
    query = "SELECT * FROM links WHERE SCANNED = 'N' LIMIT 1;";
    mysql_query(query, function(rows, fields, err) {
        if (err) {
            logMessage("processURLQueue Query A Failure:"+err);
            callback(false);
        }
        else {
            if (rows.length != 0) {
                link = {};
                link.id = rows[0].LINKID;
                link.url = rows[0].LINKURL;
                link.srcid = rows[0].SOURCELINKID;
                link.srcurl = rows[0].SOURCEURL;
                link.srcorigin = rows[0].SOURCEORIGIN;

                serverState = "processing";
                logMessage("Processing URL #"+link.id+" ("+truncateURL(link.url, 50)+")");

                scanURL(link, function(data) {
                    logMessage("Processing URL #"+link.id+" complete.");
                });
            }
            else {
                serverState = "idle";
                logMessage("All links processed. Server going idle.");
            }
        }
    });
}

function scanURL(link, callback) {
    getURL(link.url, function(result) {
        if (result.succeeded == true) {
            query = "UPDATE links SET SCANNED='Y', SUCCEEDED = 'Y' WHERE LINKID = '"+link.id+"'";
            mysql_query(query, function(rows, fields, err) {
                if (err) {
                    logMessage("C Update Failure:"+err);
                }

                var extension = getExtension(link.url);
                if (extension == ".jpg" || extension == ".png" || extension == ".jpeg") {
                    if (socketServer !== false) {
                        lastPreview = {"imageData": result.response.toString('base64'), "type": result.headers["content-type"]};
                        socketServer.emit("preview", lastPreview);
                    }
                }

                linkQueue = getURLListFromResults(result.response.toString());
                lastLink = link;

                callback();
                serverState = "reviewing";
                logMessage("Found "+linkQueue.length+" links. Processing..");
                processFoundLinks();
            });
        }
        else {
            logMessage("Unable to scan URL "+link.url+": "+result.error);
            query = "UPDATE links SET SCANNED='Y', SUCCEEDED = 'N' WHERE LINKID = '"+link.id+"'";
            mysql_query(query, function(rows, fields, err) {
                if (err) {
                    logMessage("E Update Failure:"+err);
                }
            });

            callback();
            postProcessCheck();
        }
    });
}

function processFoundLinks() {
    if (linkQueue.length > 0) {
        var foundLink = linkQueue[0];
        if (linkIsAcceptable(foundLink)) {
            
            link = {};
            link.url = foundLink;
            link.srcid = lastLink.id;
            link.srcorigin = "S";
            link.srcurl = lastLink.url;
            
            addLinkToQueue(link, function(result) {
                if (result) {
                    linksAddedInBatch++;
                }

                linkQueue.splice(0,1);
                postProcessCheck();
            });
        }
        else {
            linkQueue.splice(0,1);
            postProcessCheck();
        }
    }
    else {
        postProcessCheck();
    }
}

function postProcessCheck() {
    if (linkQueue.length > 0) {
        processFoundLinks();
    }
    else {
        lastLink = false;
        logMessage(linksAddedInBatch+" URLs added.");
        linksAddedInBatch = 0;

        serverState = "cooldown";
        logMessage("Link processing complete. Cooldown.");
        updateStats();

        setTimeout(function() {
            processURLQueue();
        }, serverCoolDownTime*1000);
    }
}

function updateStats() {
    updateQueuedLinkCount(function() {
        updateScannedLinkCount(function() {

        });
    });
}

function updateQueuedLinkCount(callback) {
    query = "SELECT COUNT(*) AS COUNT FROM links WHERE SCANNED = 'N'";
    mysql_query(query, function(rows, fields, err) {
        if (err) {
            logMessage("updateQueuedLinkCount Query A Failure:"+err);
        }
        else {
            linkQueueCount = rows[0].COUNT;
            broadcastStatusUpdate();
        }
        callback();
    });
}

function updateScannedLinkCount(callback) {
    query = "SELECT COUNT(*) AS COUNT FROM links WHERE SCANNED = 'Y'";
    mysql_query(query, function(rows, fields, err) {
        if (err) {
            logMessage("updateScannedLinkCount Query A Failure:"+err);
        }
        else {
            linksScannedCount = rows[0].COUNT;
            broadcastStatusUpdate();
        }
    });
}

function linkIsAcceptable(url, callback) {
    var extension = getExtension(url);
    if (extension == false) {
        return false;
    }
    if (bannedExtensions.indexOf(extension) != -1) {
        return false;
    }
    return true;
}

function getExtension(url) {
    var lastDot = url.lastIndexOf(".");
    if (lastDot != -1) {
        return url.substr(lastDot, url.length-lastDot);
    }
    return false;
}

function getURL(url, callback) {
    var protocol = getURLProtocol(url);
    var result = {};

    if (protocol == "https") {
        https.get(url, function(resp) {
            var data = [];

            resp.on('data', function(chunk) {
                data.push(chunk);
            });

            resp.on('end', function() {
                var buffer = Buffer.concat(data);

                result.succeeded = true;
                result.respcode = resp.statusCode;
                result.response = buffer;
                result.headers = resp.headers;
                callback(result);
            });

        }).on("error", function (err) {
            result.error = err.message;
            result.succeeded = false;
            result.respcode = 0;
            callback(result);
        });
    }
    else if (protocol == "http") {
        http.get(url, function(resp) {
            var data = [];

            resp.on('data', function(chunk) {
                data.push(chunk);
            });

            resp.on('end', function() {
                var buffer = Buffer.concat(data);

                result.succeeded = true;
                result.respcode = resp.statusCode;
                result.response = buffer;
                result.headers = resp.headers;
                callback(result);
            });

        }).on("error", function (err) {
            result.error = err.message;
            result.succeeded = false;
            result.respcode = 0;
            callback(result);
        });
    }
    else {
        result.error = "URL does not match HTTP or HTTPS protocols.";
        result.succeeded = false;
        result.respcode = false;
        callback(result);
    }
}

function getURLProtocol(url) {
    if (url.indexOf("https:") !== -1) {
        return "https";
    }
    else if (url.indexOf("http:") !== -1) {
        return "http";
    }
    else {
        return "unknown";
    }
}

function getURLListFromResults(results) {
    var links = [];
    var possible = [...results.matchAll(URL_REGEX)];
    if (possible != undefined) {
        for (p=0; p<possible.length; p++) {
            links.push(possible[p][0]);
        }
    }
    return links;
}

function truncateURL(url, length) {
    if (url.length <= length) {
        return url;
    }
    else {
        return url.substr(0,length-9)+"..."+url.substr(url.length-6,6);
    }
}

//General Functions
function getCurrentTimestamp () {
    return Math.floor(Date.now()/1000);
}

function generateDate() {
	var d = new Date();
	var dateString = ((d.getMonth()+1)<10?"0"+(d.getMonth()+1):(d.getMonth()+1)) + "/" + (d.getDate()<10?"0"+d.getDate():d.getDate()) + "/" + d.getFullYear() + " " + (d.getHours()<10?"0"+d.getHours():d.getHours()) + ":" + (d.getMinutes()<10?"0"+d.getMinutes():d.getMinutes()) + ":"  + (d.getSeconds()<10?"0"+d.getSeconds():d.getSeconds());
	return dateString;
}

function logMessage(text) {
    console.log("["+generateDate()+"] "+text);
    var date = new Date();
    var months = "JanFebMarAprMayJunJulAugSepOctNovDec";

    var month = months.substr((date.getMonth()*3),3);
    var dom = date.getDate();
    var year = date.getFullYear();
    var hour = date.getHours();
    var mins = date.getMinutes();
    var secs = date.getSeconds();

    var datetimeStr = "";
    datetimeStr = datetimeStr = month+" "+
    (dom < 10?"0"+dom:dom)+" "+
    year+" "+
    (hour < 10?"0"+hour:hour)+":"+
    (mins < 10?"0"+mins:mins)+":"+
    (secs < 10?"0"+secs:secs);

    var writeStr = "["+datetimeStr+"] "+text;

    fs.exists("server.log", function(exists) {
        if (!exists) {
            fs.writeFile("server.log", writeStr+"\n", function(err) {
                if(err) {
                    console.log("ERROR: LOG FILE:"+err);
                }
            });
        }
        else {
            fs.appendFile("server.log", writeStr+"\n", function(err) {
                if(err) {
                    console.log("ERROR: LOG FILE:"+err);
                }
            });
        }
    });

    progressLog.push(writeStr);
    if (progressLog > 50) {
        var start = progressLog.length - 50;
        progressLog.splice(start, 50);
    }

    broadcastStatusUpdate();
}

// MySQL
function mysql_escape(data) {
    return connection.escape(data);
}

function mysql_query(query, callback) {
    if (sqlConnected == true) {
        connection.query(query, function(err, rows, fields) {
            if (callback != undefined) {
                callback(rows,fields,err);
            }
        });
    }
    else {
        if (callback != undefined) {
            callback(false,false,false);
        }
    }
}

function handleDisconnect() {
	connection = mysql.createConnection(db_config);             			// Recreate the connection, since
	                                                           				// the old one cannot be reused.
	connection.connect(function(err) {                          			// The server is either down
		if(err) {                                                 			// or restarting (takes a while sometimes).
			logMessage('MySQL Cannot Reconnect:'+ err.code);
            logError('MySQL Cannot Reconnect:'+ err.code);
			setTimeout(handleDisconnect, 5000);                     		// We introduce a delay before attempting to reconnect,
			sqlConnected = false;
		}                                                         			// to avoid a hot loop, and to allow our node script to
		else {                                                    			// process asynchronous requests in the meantime.
			logMessage("MySQL Connected.");                                 // If you're also serving http, display a 503 error.
			sqlConnected = true;
			if (firstConnection == true) {
				//initialize Message
                onInitialization();
				firstConnection = false;
			}
		}
	});

	connection.on('error', function(err) {
		logMessage('ERROR:'+ err.code);		// Connection to the MySQL server is usually lost due to either server restart, or a
        logError('ERROR:'+ err.code);
		sqlConnected = false;												// connnection idle timeout (the wait_timeout server variable configures this)
		handleDisconnect();
	});
}