$(function() {
    onInitialization();
});

var socket = false;

function onInitialization() {
    console.log("Ready.");
    $('#server-status').html("Offline");

    socket = io("https://ca1.pghnetwork.net:9000");

    socket.on('connect', function() {
        $('#server-status').html("Online");
    });

    socket.on('disconnect', function() {
        clearStatusUpdate();
        $('#server-status').html("Offline");
    });

    socket.on('welcome', function(data) {
        socket.emit("identify", {id: data.id});
    });

    socket.on('preview', function(data) {
        $('#preview-img').css('background-image', "url('data:"+data.type+";base64,"+data.imageData+"')");
    });

    socket.on('status', function(data) {
        processStatusUpdate(data);
    });

    $('#scan-url-submit').click(function(e) {
        e.preventDefault();

        if ($('#scan-url').val() == "") {
            return alert("You must insert a URL.");
        }

        var url = $('#scan-url').val();
        if (url.indexOf("http") === false && url.indexOf("https") === false) {
            return alert("You must insert a URL with HTTP or HTTPS.");
        }

        $('#scan-url').val('');
        socket.emit("scan", {"url":url});
    });
}

function processStatusUpdate(data) {
    $('#server-status').html("Online");
    $('#server-state').html(processServerStatus(data.serverState));
    $('#links-scanned').html(data.linksScanned);
    $('#queue-size').html(data.queueSize);
    updateProgressBox(data.progressLog);
}

function clearStatusUpdate() {
    $('#server-status').html("");
    $('#server-state').html("");
    $('#links-scanned').html("");
    $('#queue-size').html("");
}

function getCurrentTimestamp () {
    return Math.floor(Date.now()/1000);
}

function processServerStatus(status) {
    if (status == "idle") {
        return "Idle - Waiting for URL";
    }
    if (status == "cooldown") {
        return "Cooldown (5 Seconds)";
    }
    if (status == "processing") {
        return "Processing URL";
    }
    if (status == "reviewing") {
        return "Processing Found Links";
    }
    else {
        return "Unknown";
    }
}

function updateProgressBox(progress) {
    $('#progress-box').val(progress.join("\n"));
    $('#progress-box').scrollTop($('#progress-box')[0].scrollHeight);
}