/**
 * Protocol Interface
 *
 * Each protocol handler must implement the following methods:
 *
 * @method encodeFrame(cmd, data, seqNo, sessionKey, deviceKey)
 *   Encodes a command into a binary frame.
 *   @param {number} cmd - Command code.
 *   @param {Buffer} data - Payload data.
 *   @param {number} [seqNo] - Sequence number.
 *   @param {Buffer} [sessionKey] - Session key (for v3.4/v3.5).
 *   @param {Buffer} [deviceKey] - Device local key.
 *   @returns {Buffer} Encoded frame.
 *
 * @method decodeFrame(frame, deviceKey, sessionKey)
 *   Decodes a binary frame into its components.
 *   @param {Buffer} frame - The complete frame.
 *   @param {Buffer} [deviceKey] - Device local key.
 *   @param {Buffer} [sessionKey] - Session key.
 *   @returns {{ seqno, cmd, retcode, payload, hmacOk } | null}
 *
 * @method isFrameComplete(buffer)
 *   Checks whether a buffer contains a complete frame.
 *   @param {Buffer} buffer - Raw data buffer.
 *   @returns {boolean}
 *
 * @method extractFrame(buffer)
 *   Extracts the first complete frame from a buffer, tolerating leading garbage.
 *   @param {Buffer} buffer - Raw data buffer.
 *   @returns {{ frame: Buffer, remaining: Buffer } | null}
 */

module.exports = {};
