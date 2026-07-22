const ProtocolV31V32 = require('./ProtocolV31V32');
const ProtocolV33 = require('./ProtocolV33');
const ProtocolV34 = require('./ProtocolV34');
const ProtocolV35 = require('./ProtocolV35');

function createProtocol(version) {
  switch (version) {
    case '3.1':
      return new ProtocolV31V32('3.1');
    case '3.2':
      return new ProtocolV31V32('3.2');
    case '3.3':
      return new ProtocolV33();
    case '3.4':
      return new ProtocolV34();
    case '3.5':
      return new ProtocolV35();
    default:
      throw new Error('Unknown protocol version: ' + version);
  }
}

module.exports = { createProtocol };
