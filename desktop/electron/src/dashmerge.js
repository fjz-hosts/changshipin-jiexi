'use strict'

/**
 * B 站 DASH（音视频分离的 fMP4）→ 单文件 MP4。
 *
 * 纯 JS 实现，不依赖 ffmpeg：用 mp4box.js 解出两路 samples，
 * 再用 mp4-muxer 重新封装成一个带音轨 + 视频轨的普通 MP4。
 * 输入是两个 Buffer（DASH 的 m4s/mp4 整段），输出是 Buffer。
 */

const MP4Box = require('mp4box')
const { Muxer, ArrayBufferTarget } = require('mp4-muxer')

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
}

function appendBuffer(file, arrayBuffer) {
  const boxed =
    MP4Box.MP4BoxBuffer && typeof MP4Box.MP4BoxBuffer.fromArrayBuffer === 'function'
      ? MP4Box.MP4BoxBuffer.fromArrayBuffer(arrayBuffer, 0)
      : Object.assign(arrayBuffer, { fileStart: 0 })
  file.appendBuffer(boxed)
}

function boxDescription(entry) {
  if (!entry) return ''
  const box = entry.avcC || entry.hvcC
  if (!box || typeof box.write !== 'function') return ''
  const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN)
  box.write(stream)
  const bytes = new Uint8Array(stream.buffer)
  // 去掉 4 字节 size + 4 字节 box type，只留配置内容
  return bytes.slice(8)
}

function parseStream(buffer, wantVideo) {
  return new Promise((resolve, reject) => {
    const file = MP4Box.createFile()
    const samples = []
    let track = null
    file.onReady = (info) => {
      track = wantVideo ? info.videoTracks[0] : info.audioTracks[0]
      if (!track) {
        reject(new Error(wantVideo ? '没有找到视频轨' : '没有找到音频轨'))
        return
      }
      file.setExtractionOptions(track.id, null, { nbSamples: 100000 })
      file.start()
    }
    file.onSamples = (_id, _user, list) => {
      for (const sample of list) samples.push(sample)
    }
    file.onError = (error) => reject(new Error(`解析失败：${error}`))
    try {
      appendBuffer(file, toArrayBuffer(buffer))
      file.flush()
    } catch (error) {
      reject(error)
      return
    }
    if (!track) {
      reject(new Error('没有解析到轨道信息'))
      return
    }
    if (!samples.length) {
      reject(new Error('没有解析到可用的采样'))
      return
    }
    resolve({ file, track, samples })
  })
}

function microseconds(value, timescale) {
  return Math.round((Number(value) / timescale) * 1e6)
}

async function mergeDash(videoBuffer, audioBuffer, onProgress = () => {}) {
  const video = await parseStream(videoBuffer, true)
  onProgress(0.3)
  const audio = await parseStream(audioBuffer, false)
  onProgress(0.6)

  const vEntry = video.file.getTrackById(video.track.id)?.mdia?.minf?.stbl?.stsd?.entries?.[0]
  const description = boxDescription(vEntry)
  const videoCodec = description && vEntry?.hvcC ? 'hevc' : 'avc'
  if (!description) throw new Error('视频编码信息缺失，无法合并')

  const target = new ArrayBufferTarget()
  const muxer = new Muxer({
    target,
    video: {
      codec: videoCodec,
      width: Number(video.track.video?.width) || 0,
      height: Number(video.track.video?.height) || 0,
    },
    audio: {
      codec: 'aac',
      sampleRate: Number(audio.track.audio?.sample_rate) || 44100,
      numberOfChannels: Number(audio.track.audio?.channel_count) || 2,
    },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'cross-track-offset',
  })

  const vt = Number(video.track.timescale) || 1
  for (let index = 0; index < video.samples.length; index += 1) {
    const sample = video.samples[index]
    muxer.addVideoChunkRaw(
      sample.data instanceof Uint8Array ? sample.data : new Uint8Array(sample.data),
      sample.is_sync ? 'key' : 'delta',
      microseconds(sample.cts, vt),
      microseconds(sample.duration, vt),
      index === 0 ? { decoderConfig: { codec: video.track.codec, description } } : undefined,
      microseconds(sample.cts - sample.dts, vt),
    )
  }
  onProgress(0.8)

  const at = Number(audio.track.timescale) || 1
  for (const sample of audio.samples) {
    muxer.addAudioChunkRaw(
      sample.data instanceof Uint8Array ? sample.data : new Uint8Array(sample.data),
      'key',
      microseconds(sample.cts, at),
      microseconds(sample.duration, at),
    )
  }

  muxer.finalize()
  onProgress(1)
  return Buffer.from(target.buffer)
}

module.exports = { mergeDash }
