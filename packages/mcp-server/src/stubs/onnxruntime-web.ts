/**
 * Build-time stand-in for onnxruntime-web - see tsup.config.ts.
 *
 * @xenova/transformers imports onnxruntime-web unconditionally, but under Node
 * it only ever runs on onnxruntime-node: its backends/onnx.js picks the
 * backend by `process.release.name` and never touches the web one. Shipping
 * the real package cost every install 68 MB, plus onnx-proto's protobufjs 6
 * with its critical advisory, which no override of ours can reach in a
 * consumer's install tree (2026-09-08 audit F11).
 */
export default {}
