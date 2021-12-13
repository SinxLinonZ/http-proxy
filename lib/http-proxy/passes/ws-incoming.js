var http   = require('http'),
    https  = require('https'),
    common = require('../common');

/*!
 * Array of passes.
 *
 * A `pass` is just a function that is executed on `req, socket, options`
 * so that you can easily add new checks while still keeping the base
 * flexible.
 */

/*
 * Websockets Passes
 *
 */


/**
 * Parse websocket message
 * @param {Buffer} data Buffer data
 * @param {bool} serverMsg Is msg from server or not
 * @returns false: not a valid msg or empty payload
 *          {String}: payload msg
 */
 
 function ParseWS(data, serverMsg = false) {
  let pointer = 1;
  let length = data.readUInt8(pointer);
  pointer++;

  // no payload data
  if (length == 0) return false;

  // check is server msg or client msg
  let MASKED = false;
  if (serverMsg) {
    MASKED = true;
  }
  else {
    if (length > 127) {
      length -= 128;
      MASKED = true;
    } 
    // return if client msg is not masked
    else {return false}
  }

  // double check if is valid msg
  if (!MASKED) return false;

  // get payload length
  if (length == 126) {
    length = data.readUInt16BE(pointer);
    pointer += 2;
  }
  if (length == 127) {
    length = data.readBigInt64BE(pointer);
    pointer += 8;
  }

  let DECODED;
  let MASK;

  // client msg
  if (!serverMsg) {
    // get mask
    MASK = data.slice(pointer, pointer + 4);
    pointer += 4;
    // unmask payload
    let ENCODED = data.slice(pointer);
    DECODED = Buffer.alloc(ENCODED.length);
    for (var i = 0; i < ENCODED.length; i++) {
      DECODED[i] = ENCODED[i] ^ MASK[i % 4];
    }
  
    DECODED = DECODED.toString();
  } else {
    // server msg, read directly
    DECODED = data.slice(pointer).toString();
  }

  // return msg if is not empty
  return DECODED == "" ? false : DECODED;
}


module.exports = {
  /**
   * WebSocket requests must have the `GET` method and
   * the `upgrade:websocket` header
   *
   * @param {ClientRequest} Req Request object
   * @param {Socket} Websocket
   *
   * @api private
   */

  checkMethodAndHeader : function checkMethodAndHeader(req, socket) {
    if (req.method !== 'GET' || !req.headers.upgrade) {
      socket.destroy();
      return true;
    }

    if (req.headers.upgrade.toLowerCase() !== 'websocket') {
      socket.destroy();
      return true;
    }
  },

  /**
   * Sets `x-forwarded-*` headers if specified in config.
   *
   * @param {ClientRequest} Req Request object
   * @param {Socket} Websocket
   * @param {Object} Options Config object passed to the proxy
   *
   * @api private
   */

  XHeaders : function XHeaders(req, socket, options) {
    if(!options.xfwd) return;

    var values = {
      for  : req.connection.remoteAddress || req.socket.remoteAddress,
      port : common.getPort(req),
      proto: common.hasEncryptedConnection(req) ? 'wss' : 'ws'
    };

    ['for', 'port', 'proto'].forEach(function(header) {
      req.headers['x-forwarded-' + header] =
        (req.headers['x-forwarded-' + header] || '') +
        (req.headers['x-forwarded-' + header] ? ',' : '') +
        values[header];
    });
  },

  /**
   * Does the actual proxying. Make the request and upgrade it
   * send the Switching Protocols request and pipe the sockets.
   *
   * @param {ClientRequest} Req Request object
   * @param {Socket} Websocket
   * @param {Object} Options Config object passed to the proxy
   *
   * @api private
   */
  stream : function stream(req, socket, options, head, server, clb) {

    var createHttpHeader = function(line, headers) {
      return Object.keys(headers).reduce(function (head, key) {
        var value = headers[key];

        if (!Array.isArray(value)) {
          head.push(key + ': ' + value);
          return head;
        }

        for (var i = 0; i < value.length; i++) {
          head.push(key + ': ' + value[i]);
        }
        return head;
      }, [line])
      .join('\r\n') + '\r\n\r\n';
    }

    common.setupSocket(socket);

    if (head && head.length) socket.unshift(head);


    var proxyReq = (common.isSSL.test(options.target.protocol) ? https : http).request(
      common.setupOutgoing(options.ssl || {}, options, req)
    );

    // Enable developers to modify the proxyReq before headers are sent
    if (server) { server.emit('proxyReqWs', proxyReq, req, socket, options, head); }

    // Error Handler
    proxyReq.on('error', onOutgoingError);
    proxyReq.on('response', function (res) {
      // if upgrade event isn't going to happen, close the socket
      if (!res.upgrade) {
        socket.write(createHttpHeader('HTTP/' + res.httpVersion + ' ' + res.statusCode + ' ' + res.statusMessage, res.headers));
        res.pipe(socket);
      }
    });

    proxyReq.on('upgrade', function(proxyRes, proxySocket, proxyHead) {
      proxySocket.on('error', onOutgoingError);

      // Allow us to listen when the websocket has completed
      proxySocket.on('end', function () {
        server.emit('close', proxyRes, proxySocket, proxyHead);
      });

      // The pipe below will end proxySocket if socket closes cleanly, but not
      // if it errors (eg, vanishes from the net and starts returning
      // EHOSTUNREACH). We need to do that explicitly.
      socket.on('error', function () {
        proxySocket.end();
      });

      common.setupSocket(proxySocket);

      if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);

      //
      // Remark: Handle writing the headers to the socket when switching protocols
      // Also handles when a header is an array
      //
      socket.write(createHttpHeader('HTTP/1.1 101 Switching Protocols', proxyRes.headers));

      proxySocket.pipe(socket).pipe(proxySocket);

      proxySocket.on('data', (data) => {
        console.log("SERVER: ");
        console.log(JSON.parse(ParseWS(data, true)));
        console.log();
      });
      socket.on('data', (data) => {
        console.log("CLIENT: ");
        console.log(JSON.parse(ParseWS(data)));
        console.log();
      });

      server.emit('open', proxySocket);
      server.emit('proxySocket', proxySocket);  //DEPRECATED.
    });

    return proxyReq.end(); // XXX: CHECK IF THIS IS THIS CORRECT

    function onOutgoingError(err) {
      if (clb) {
        clb(err, req, socket);
      } else {
        server.emit('error', err, req, socket);
      }
      socket.end();
    }
  }
};
