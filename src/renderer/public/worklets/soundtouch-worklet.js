/* SPDX-License-Identifier: LGPL-2.1-or-later
 * Vendored from soundtouchjs v0.3.0 (https://github.com/cutterbl/SoundTouchJS).
 * Modified for Karaoke Player: AudioWorklet adapter, streaming input,
 * priming, latency reporting and seek handling. Licensing notice updated 2026-09-06.
 * Copyright 2026 mgkwak (project modifications).
 * This entire file, including the adapter and modifications, remains LGPL-2.1-or-later;
 * it is excluded from the project's Apache-2.0 license. See LICENSE_SCOPE.md and
 * scripts/licenses/LGPL-2.1.txt. Upstream notices are preserved below.
 * AudioWorklet은 모듈 import가 제한되어 단일 파일로 동봉한다. */
/*
 * SoundTouch JS v0.3.0 audio processing library
 * Copyright (c) Olli Parviainen
 * Copyright (c) Ryan Berdeen
 * Copyright (c) Jakub Fiala
 * Copyright (c) Steve 'Cutter' Blades
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
 */

class FifoSampleBuffer {
  constructor() {
    this._vector = new Float32Array()
    this._position = 0
    this._frameCount = 0
  }
  get vector() {
    return this._vector
  }
  get position() {
    return this._position
  }
  get startIndex() {
    return this._position * 2
  }
  get frameCount() {
    return this._frameCount
  }
  get endIndex() {
    return (this._position + this._frameCount) * 2
  }
  clear() {
    this._vector.fill(0)
    this._position = 0
    this._frameCount = 0
  }
  put(numFrames) {
    this._frameCount += numFrames
  }
  putSamples(samples, position, numFrames = 0) {
    position = position || 0
    const sourceOffset = position * 2
    if (!(numFrames >= 0)) {
      numFrames = (samples.length - sourceOffset) / 2
    }
    const numSamples = numFrames * 2
    this.ensureCapacity(numFrames + this._frameCount)
    const destOffset = this.endIndex
    this.vector.set(samples.subarray(sourceOffset, sourceOffset + numSamples), destOffset)
    this._frameCount += numFrames
  }
  putBuffer(buffer, position, numFrames = 0) {
    position = position || 0
    if (!(numFrames >= 0)) {
      numFrames = buffer.frameCount - position
    }
    this.putSamples(buffer.vector, buffer.position + position, numFrames)
  }
  receive(numFrames) {
    if (!(numFrames >= 0) || numFrames > this._frameCount) {
      numFrames = this.frameCount
    }
    this._frameCount -= numFrames
    this._position += numFrames
  }
  receiveSamples(output, numFrames = 0) {
    const numSamples = numFrames * 2
    const sourceOffset = this.startIndex
    output.set(this._vector.subarray(sourceOffset, sourceOffset + numSamples))
    this.receive(numFrames)
  }
  extract(output, position = 0, numFrames = 0) {
    const sourceOffset = this.startIndex + position * 2
    const numSamples = numFrames * 2
    output.set(this._vector.subarray(sourceOffset, sourceOffset + numSamples))
  }
  ensureCapacity(numFrames = 0) {
    const minLength = parseInt(numFrames * 2)
    if (this._vector.length < minLength) {
      const newVector = new Float32Array(minLength)
      newVector.set(this._vector.subarray(this.startIndex, this.endIndex))
      this._vector = newVector
      this._position = 0
    } else {
      this.rewind()
    }
  }
  ensureAdditionalCapacity(numFrames = 0) {
    this.ensureCapacity(this._frameCount + numFrames)
  }
  rewind() {
    if (this._position > 0) {
      this._vector.set(this._vector.subarray(this.startIndex, this.endIndex))
      this._position = 0
    }
  }
}

class AbstractFifoSamplePipe {
  constructor(createBuffers) {
    if (createBuffers) {
      this._inputBuffer = new FifoSampleBuffer()
      this._outputBuffer = new FifoSampleBuffer()
    } else {
      this._inputBuffer = this._outputBuffer = null
    }
  }
  get inputBuffer() {
    return this._inputBuffer
  }
  set inputBuffer(inputBuffer) {
    this._inputBuffer = inputBuffer
  }
  get outputBuffer() {
    return this._outputBuffer
  }
  set outputBuffer(outputBuffer) {
    this._outputBuffer = outputBuffer
  }
  clear() {
    this._inputBuffer.clear()
    this._outputBuffer.clear()
  }
}

class RateTransposer extends AbstractFifoSamplePipe {
  constructor(createBuffers) {
    super(createBuffers)
    this.reset()
    this._rate = 1
  }
  set rate(rate) {
    this._rate = rate
  }
  reset() {
    this.slopeCount = 0
    this.prevSampleL = 0
    this.prevSampleR = 0
  }
  clear() {
    super.clear()
    this.reset()
  }
  clone() {
    const result = new RateTransposer()
    result.rate = this._rate
    return result
  }
  process() {
    const numFrames = this._inputBuffer.frameCount
    this._outputBuffer.ensureAdditionalCapacity(numFrames / this._rate + 1)
    const numFramesOutput = this.transpose(numFrames)
    this._inputBuffer.receive()
    this._outputBuffer.put(numFramesOutput)
  }
  transpose(numFrames = 0) {
    if (numFrames === 0) {
      return 0
    }
    const src = this._inputBuffer.vector
    const srcOffset = this._inputBuffer.startIndex
    const dest = this._outputBuffer.vector
    const destOffset = this._outputBuffer.endIndex
    let used = 0
    let i = 0
    while (this.slopeCount < 1.0) {
      dest[destOffset + 2 * i] =
        (1.0 - this.slopeCount) * this.prevSampleL + this.slopeCount * src[srcOffset]
      dest[destOffset + 2 * i + 1] =
        (1.0 - this.slopeCount) * this.prevSampleR + this.slopeCount * src[srcOffset + 1]
      i = i + 1
      this.slopeCount += this._rate
    }
    this.slopeCount -= 1.0
    if (numFrames !== 1) {
      out: while (true) {
        while (this.slopeCount > 1.0) {
          this.slopeCount -= 1.0
          used = used + 1
          if (used >= numFrames - 1) {
            break out
          }
        }
        const srcIndex = srcOffset + 2 * used
        dest[destOffset + 2 * i] =
          (1.0 - this.slopeCount) * src[srcIndex] + this.slopeCount * src[srcIndex + 2]
        dest[destOffset + 2 * i + 1] =
          (1.0 - this.slopeCount) * src[srcIndex + 1] + this.slopeCount * src[srcIndex + 3]
        i = i + 1
        this.slopeCount += this._rate
      }
    }
    this.prevSampleL = src[srcOffset + 2 * numFrames - 2]
    this.prevSampleR = src[srcOffset + 2 * numFrames - 1]
    return i
  }
}

/* karaoke-player: SimpleFilter 처리 배치. 원본 16384(371ms)는 지연이 과도해 4096으로 축소.
 * Stretch 윈도우 요구량(약 55ms)보다 커야 한다. */
const FILL_BATCH_FRAMES = 4096

class FilterSupport {
  constructor(pipe) {
    this._pipe = pipe
  }
  get pipe() {
    return this._pipe
  }
  get inputBuffer() {
    return this._pipe.inputBuffer
  }
  get outputBuffer() {
    return this._pipe.outputBuffer
  }
  fillInputBuffer() {
    throw new Error('fillInputBuffer() not overridden')
  }
  fillOutputBuffer(numFrames = 0) {
    while (this.outputBuffer.frameCount < numFrames) {
      const numInputFrames = FILL_BATCH_FRAMES - this.inputBuffer.frameCount /* karaoke-player: 배치 축소(지연 감소) */
      this.fillInputBuffer(numInputFrames)
      if (this.inputBuffer.frameCount < FILL_BATCH_FRAMES) {
        break
      }
      this._pipe.process()
    }
  }
  clear() {
    this._pipe.clear()
  }
}

const noop = function () {
  return
}

class SimpleFilter extends FilterSupport {
  constructor(sourceSound, pipe, callback = noop) {
    super(pipe)
    this.callback = callback
    this.sourceSound = sourceSound
    this.historyBufferSize = 22050
    this._sourcePosition = 0
    this.outputBufferPosition = 0
    this._position = 0
  }
  get position() {
    return this._position
  }
  set position(position) {
    if (position > this._position) {
      throw new RangeError('New position may not be greater than current position')
    }
    const newOutputBufferPosition = this.outputBufferPosition - (this._position - position)
    if (newOutputBufferPosition < 0) {
      throw new RangeError('New position falls outside of history buffer')
    }
    this.outputBufferPosition = newOutputBufferPosition
    this._position = position
  }
  get sourcePosition() {
    return this._sourcePosition
  }
  set sourcePosition(sourcePosition) {
    this.clear()
    this._sourcePosition = sourcePosition
  }
  onEnd() {
    this.callback()
  }
  fillInputBuffer(numFrames = 0) {
    const samples = new Float32Array(numFrames * 2)
    const numFramesExtracted = this.sourceSound.extract(samples, numFrames, this._sourcePosition)
    this._sourcePosition += numFramesExtracted
    this.inputBuffer.putSamples(samples, 0, numFramesExtracted)
  }
  extract(target, numFrames = 0) {
    this.fillOutputBuffer(this.outputBufferPosition + numFrames)
    const numFramesExtracted = Math.min(
      numFrames,
      this.outputBuffer.frameCount - this.outputBufferPosition
    )
    this.outputBuffer.extract(target, this.outputBufferPosition, numFramesExtracted)
    const currentFrames = this.outputBufferPosition + numFramesExtracted
    this.outputBufferPosition = Math.min(this.historyBufferSize, currentFrames)
    this.outputBuffer.receive(Math.max(currentFrames - this.historyBufferSize, 0))
    this._position += numFramesExtracted
    return numFramesExtracted
  }
  handleSampleData(event) {
    this.extract(event.data, 4096)
  }
  clear() {
    super.clear()
    this.outputBufferPosition = 0
  }
}

const USE_AUTO_SEQUENCE_LEN = 0
const DEFAULT_SEQUENCE_MS = USE_AUTO_SEQUENCE_LEN
const USE_AUTO_SEEKWINDOW_LEN = 0
const DEFAULT_SEEKWINDOW_MS = USE_AUTO_SEEKWINDOW_LEN
const DEFAULT_OVERLAP_MS = 8
const _SCAN_OFFSETS = [
  [
    124, 186, 248, 310, 372, 434, 496, 558, 620, 682, 744, 806, 868, 930, 992, 1054, 1116, 1178,
    1240, 1302, 1364, 1426, 1488, 0
  ],
  [-100, -75, -50, -25, 25, 50, 75, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [-20, -15, -10, -5, 5, 10, 15, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [-4, -3, -2, -1, 1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
]
const AUTOSEQ_TEMPO_LOW = 0.25
const AUTOSEQ_TEMPO_TOP = 4.0
const AUTOSEQ_AT_MIN = 125.0
const AUTOSEQ_AT_MAX = 50.0
const AUTOSEQ_K = (AUTOSEQ_AT_MAX - AUTOSEQ_AT_MIN) / (AUTOSEQ_TEMPO_TOP - AUTOSEQ_TEMPO_LOW)
const AUTOSEQ_C = AUTOSEQ_AT_MIN - AUTOSEQ_K * AUTOSEQ_TEMPO_LOW
const AUTOSEEK_AT_MIN = 25.0
const AUTOSEEK_AT_MAX = 15.0
const AUTOSEEK_K = (AUTOSEEK_AT_MAX - AUTOSEEK_AT_MIN) / (AUTOSEQ_TEMPO_TOP - AUTOSEQ_TEMPO_LOW)
const AUTOSEEK_C = AUTOSEEK_AT_MIN - AUTOSEEK_K * AUTOSEQ_TEMPO_LOW
class Stretch extends AbstractFifoSamplePipe {
  constructor(createBuffers) {
    super(createBuffers)
    this._quickSeek = true
    this.midBufferDirty = false
    this.midBuffer = null
    this.overlapLength = 0
    this.autoSeqSetting = true
    this.autoSeekSetting = true
    this._tempo = 1
    this.setParameters(44100, DEFAULT_SEQUENCE_MS, DEFAULT_SEEKWINDOW_MS, DEFAULT_OVERLAP_MS)
  }
  clear() {
    super.clear()
    this.clearMidBuffer()
  }
  clearMidBuffer() {
    this.midBufferDirty = false
    this.midBuffer = null
    if (this.refMidBuffer) {
      this.refMidBuffer.fill(0)
    }
    this.skipFract = 0
  }
  setParameters(sampleRate, sequenceMs, seekWindowMs, overlapMs) {
    if (sampleRate > 0) {
      this.sampleRate = sampleRate
    }
    if (overlapMs > 0) {
      this.overlapMs = overlapMs
    }
    if (sequenceMs > 0) {
      this.sequenceMs = sequenceMs
      this.autoSeqSetting = false
    } else {
      this.autoSeqSetting = true
    }
    if (seekWindowMs > 0) {
      this.seekWindowMs = seekWindowMs
      this.autoSeekSetting = false
    } else {
      this.autoSeekSetting = true
    }
    this.calculateSequenceParameters()
    this.calculateOverlapLength(this.overlapMs)
    this.tempo = this._tempo
  }
  set tempo(newTempo) {
    let intskip
    this._tempo = newTempo
    this.calculateSequenceParameters()
    this.nominalSkip = this._tempo * (this.seekWindowLength - this.overlapLength)
    this.skipFract = 0
    intskip = Math.floor(this.nominalSkip + 0.5)
    this.sampleReq = Math.max(intskip + this.overlapLength, this.seekWindowLength) + this.seekLength
  }
  get tempo() {
    return this._tempo
  }
  get inputChunkSize() {
    return this.sampleReq
  }
  get outputChunkSize() {
    return this.overlapLength + Math.max(0, this.seekWindowLength - 2 * this.overlapLength)
  }
  calculateOverlapLength(overlapInMsec = 0) {
    let newOvl
    newOvl = (this.sampleRate * overlapInMsec) / 1000
    newOvl = newOvl < 16 ? 16 : newOvl
    newOvl -= newOvl % 8
    this.overlapLength = newOvl
    this.refMidBuffer = new Float32Array(this.overlapLength * 2)
    this.midBuffer = new Float32Array(this.overlapLength * 2)
  }
  checkLimits(x, mi, ma) {
    return x < mi ? mi : x > ma ? ma : x
  }
  calculateSequenceParameters() {
    let seq
    let seek
    if (this.autoSeqSetting) {
      seq = AUTOSEQ_C + AUTOSEQ_K * this._tempo
      seq = this.checkLimits(seq, AUTOSEQ_AT_MAX, AUTOSEQ_AT_MIN)
      this.sequenceMs = Math.floor(seq + 0.5)
    }
    if (this.autoSeekSetting) {
      seek = AUTOSEEK_C + AUTOSEEK_K * this._tempo
      seek = this.checkLimits(seek, AUTOSEEK_AT_MAX, AUTOSEEK_AT_MIN)
      this.seekWindowMs = Math.floor(seek + 0.5)
    }
    this.seekWindowLength = Math.floor((this.sampleRate * this.sequenceMs) / 1000)
    this.seekLength = Math.floor((this.sampleRate * this.seekWindowMs) / 1000)
  }
  set quickSeek(enable) {
    this._quickSeek = enable
  }
  clone() {
    const result = new Stretch()
    result.tempo = this._tempo
    result.setParameters(this.sampleRate, this.sequenceMs, this.seekWindowMs, this.overlapMs)
    return result
  }
  seekBestOverlapPosition() {
    return this._quickSeek
      ? this.seekBestOverlapPositionStereoQuick()
      : this.seekBestOverlapPositionStereo()
  }
  seekBestOverlapPositionStereo() {
    let bestOffset
    let bestCorrelation
    let correlation
    let i = 0
    this.preCalculateCorrelationReferenceStereo()
    bestOffset = 0
    bestCorrelation = Number.MIN_VALUE
    for (; i < this.seekLength; i = i + 1) {
      correlation = this.calculateCrossCorrelationStereo(2 * i, this.refMidBuffer)
      if (correlation > bestCorrelation) {
        bestCorrelation = correlation
        bestOffset = i
      }
    }
    return bestOffset
  }
  seekBestOverlapPositionStereoQuick() {
    let bestOffset
    let bestCorrelation
    let correlation
    let scanCount = 0
    let correlationOffset
    let tempOffset
    this.preCalculateCorrelationReferenceStereo()
    bestCorrelation = Number.MIN_VALUE
    bestOffset = 0
    correlationOffset = 0
    tempOffset = 0
    for (; scanCount < 4; scanCount = scanCount + 1) {
      let j = 0
      while (_SCAN_OFFSETS[scanCount][j]) {
        tempOffset = correlationOffset + _SCAN_OFFSETS[scanCount][j]
        if (tempOffset >= this.seekLength) {
          break
        }
        correlation = this.calculateCrossCorrelationStereo(2 * tempOffset, this.refMidBuffer)
        if (correlation > bestCorrelation) {
          bestCorrelation = correlation
          bestOffset = tempOffset
        }
        j = j + 1
      }
      correlationOffset = bestOffset
    }
    return bestOffset
  }
  preCalculateCorrelationReferenceStereo() {
    let i = 0
    let context
    let temp
    for (; i < this.overlapLength; i = i + 1) {
      temp = i * (this.overlapLength - i)
      context = i * 2
      this.refMidBuffer[context] = this.midBuffer[context] * temp
      this.refMidBuffer[context + 1] = this.midBuffer[context + 1] * temp
    }
  }
  calculateCrossCorrelationStereo(mixingPosition, compare) {
    const mixing = this._inputBuffer.vector
    mixingPosition += this._inputBuffer.startIndex
    let correlation = 0
    let i = 2
    const calcLength = 2 * this.overlapLength
    let mixingOffset
    for (; i < calcLength; i = i + 2) {
      mixingOffset = i + mixingPosition
      correlation += mixing[mixingOffset] * compare[i] + mixing[mixingOffset + 1] * compare[i + 1]
    }
    return correlation
  }
  overlap(overlapPosition) {
    this.overlapStereo(2 * overlapPosition)
  }
  overlapStereo(inputPosition) {
    const input = this._inputBuffer.vector
    inputPosition += this._inputBuffer.startIndex
    const output = this._outputBuffer.vector
    const outputPosition = this._outputBuffer.endIndex
    let i = 0
    let context
    let tempFrame
    const frameScale = 1 / this.overlapLength
    let fi
    let inputOffset
    let outputOffset
    for (; i < this.overlapLength; i = i + 1) {
      tempFrame = (this.overlapLength - i) * frameScale
      fi = i * frameScale
      context = 2 * i
      inputOffset = context + inputPosition
      outputOffset = context + outputPosition
      output[outputOffset + 0] =
        input[inputOffset + 0] * fi + this.midBuffer[context + 0] * tempFrame
      output[outputOffset + 1] =
        input[inputOffset + 1] * fi + this.midBuffer[context + 1] * tempFrame
    }
  }
  process() {
    let offset
    let temp
    let overlapSkip
    if (this.midBuffer === null) {
      if (this._inputBuffer.frameCount < this.overlapLength) {
        return
      }
      this.midBuffer = new Float32Array(this.overlapLength * 2)
      this._inputBuffer.receiveSamples(this.midBuffer, this.overlapLength)
    }
    while (this._inputBuffer.frameCount >= this.sampleReq) {
      offset = this.seekBestOverlapPosition()
      this._outputBuffer.ensureAdditionalCapacity(this.overlapLength)
      this.overlap(Math.floor(offset))
      this._outputBuffer.put(this.overlapLength)
      temp = this.seekWindowLength - 2 * this.overlapLength
      if (temp > 0) {
        this._outputBuffer.putBuffer(this._inputBuffer, offset + this.overlapLength, temp)
      }
      const start =
        this._inputBuffer.startIndex + 2 * (offset + this.seekWindowLength - this.overlapLength)
      this.midBuffer.set(this._inputBuffer.vector.subarray(start, start + 2 * this.overlapLength))
      this.skipFract += this.nominalSkip
      overlapSkip = Math.floor(this.skipFract)
      this.skipFract -= overlapSkip
      this._inputBuffer.receive(overlapSkip)
    }
  }
}

const testFloatEqual = function (a, b) {
  return (a > b ? a - b : b - a) > 1e-10
}

class SoundTouch {
  constructor() {
    this.transposer = new RateTransposer(false)
    this.stretch = new Stretch(false)
    this._inputBuffer = new FifoSampleBuffer()
    this._intermediateBuffer = new FifoSampleBuffer()
    this._outputBuffer = new FifoSampleBuffer()
    this._rate = 0
    this._tempo = 0
    this.virtualPitch = 1.0
    this.virtualRate = 1.0
    this.virtualTempo = 1.0
    this.calculateEffectiveRateAndTempo()
  }
  clear() {
    this.transposer.clear()
    this.stretch.clear()
  }
  clone() {
    const result = new SoundTouch()
    result.rate = this.rate
    result.tempo = this.tempo
    return result
  }
  get rate() {
    return this._rate
  }
  set rate(rate) {
    this.virtualRate = rate
    this.calculateEffectiveRateAndTempo()
  }
  set rateChange(rateChange) {
    this._rate = 1.0 + 0.01 * rateChange
  }
  get tempo() {
    return this._tempo
  }
  set tempo(tempo) {
    this.virtualTempo = tempo
    this.calculateEffectiveRateAndTempo()
  }
  set tempoChange(tempoChange) {
    this.tempo = 1.0 + 0.01 * tempoChange
  }
  set pitch(pitch) {
    this.virtualPitch = pitch
    this.calculateEffectiveRateAndTempo()
  }
  set pitchOctaves(pitchOctaves) {
    this.pitch = Math.exp(0.69314718056 * pitchOctaves)
    this.calculateEffectiveRateAndTempo()
  }
  set pitchSemitones(pitchSemitones) {
    this.pitchOctaves = pitchSemitones / 12.0
  }
  get inputBuffer() {
    return this._inputBuffer
  }
  get outputBuffer() {
    return this._outputBuffer
  }
  calculateEffectiveRateAndTempo() {
    const previousTempo = this._tempo
    const previousRate = this._rate
    this._tempo = this.virtualTempo / this.virtualPitch
    this._rate = this.virtualRate * this.virtualPitch
    if (testFloatEqual(this._tempo, previousTempo)) {
      this.stretch.tempo = this._tempo
    }
    if (testFloatEqual(this._rate, previousRate)) {
      this.transposer.rate = this._rate
    }
    if (this._rate > 1.0) {
      if (this._outputBuffer != this.transposer.outputBuffer) {
        this.stretch.inputBuffer = this._inputBuffer
        this.stretch.outputBuffer = this._intermediateBuffer
        this.transposer.inputBuffer = this._intermediateBuffer
        this.transposer.outputBuffer = this._outputBuffer
      }
    } else {
      if (this._outputBuffer != this.stretch.outputBuffer) {
        this.transposer.inputBuffer = this._inputBuffer
        this.transposer.outputBuffer = this._intermediateBuffer
        this.stretch.inputBuffer = this._intermediateBuffer
        this.stretch.outputBuffer = this._outputBuffer
      }
    }
  }
  process() {
    if (this._rate > 1.0) {
      this.stretch.process()
      this.transposer.process()
    } else {
      this.transposer.process()
      this.stretch.process()
    }
  }
}

class WebAudioBufferSource {
  constructor(buffer) {
    this.buffer = buffer
    this._position = 0
  }
  get dualChannel() {
    return this.buffer.numberOfChannels > 1
  }
  get position() {
    return this._position
  }
  set position(value) {
    this._position = value
  }
  extract(target, numFrames = 0, position = 0) {
    this.position = position
    let left = this.buffer.getChannelData(0)
    let right = this.dualChannel ? this.buffer.getChannelData(1) : this.buffer.getChannelData(0)
    let i = 0
    for (; i < numFrames; i++) {
      target[i * 2] = left[i + position]
      target[i * 2 + 1] = right[i + position]
    }
    return Math.min(numFrames, left.length - position)
  }
}

const getWebAudioNode = function (
  context,
  filter,
  sourcePositionCallback = noop,
  bufferSize = 4096
) {
  const node = context.createScriptProcessor(bufferSize, 2, 2)
  const samples = new Float32Array(bufferSize * 2)
  node.onaudioprocess = (event) => {
    let left = event.outputBuffer.getChannelData(0)
    let right = event.outputBuffer.getChannelData(1)
    let framesExtracted = filter.extract(samples, bufferSize)
    sourcePositionCallback(filter.sourcePosition)
    if (framesExtracted === 0) {
      filter.onEnd()
    }
    let i = 0
    for (; i < framesExtracted; i++) {
      left[i] = samples[i * 2]
      right[i] = samples[i * 2 + 1]
    }
  }
  return node
}

const pad = function (n, width, z) {
  z = z || '0'
  n = n + ''
  return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n
}
const minsSecs = function (secs) {
  const mins = Math.floor(secs / 60)
  const seconds = secs - mins * 60
  return `${mins}:${pad(parseInt(seconds), 2)}`
}

const onUpdate = function (sourcePosition) {
  const currentTimePlayed = this.timePlayed
  const sampleRate = this.sampleRate
  this.sourcePosition = sourcePosition
  this.timePlayed = sourcePosition / sampleRate
  if (currentTimePlayed !== this.timePlayed) {
    const timePlayed = new CustomEvent('play', {
      detail: {
        timePlayed: this.timePlayed,
        formattedTimePlayed: this.formattedTimePlayed,
        percentagePlayed: this.percentagePlayed
      }
    })
    this._node.dispatchEvent(timePlayed)
  }
}
class PitchShifter {
  constructor(context, buffer, bufferSize, onEnd = noop) {
    this._soundtouch = new SoundTouch()
    const source = new WebAudioBufferSource(buffer)
    this.timePlayed = 0
    this.sourcePosition = 0
    this._filter = new SimpleFilter(source, this._soundtouch, onEnd)
    this._node = getWebAudioNode(
      context,
      this._filter,
      (sourcePostion) => onUpdate.call(this, sourcePostion),
      bufferSize
    )
    this.tempo = 1
    this.rate = 1
    this.duration = buffer.duration
    this.sampleRate = context.sampleRate
    this.listeners = []
  }
  get formattedDuration() {
    return minsSecs(this.duration)
  }
  get formattedTimePlayed() {
    return minsSecs(this.timePlayed)
  }
  get percentagePlayed() {
    return (100 * this._filter.sourcePosition) / (this.duration * this.sampleRate)
  }
  set percentagePlayed(perc) {
    this._filter.sourcePosition = parseInt(perc * this.duration * this.sampleRate)
    this.sourcePosition = this._filter.sourcePosition
    this.timePlayed = this.sourcePosition / this.sampleRate
  }
  get node() {
    return this._node
  }
  set pitch(pitch) {
    this._soundtouch.pitch = pitch
  }
  set pitchSemitones(semitone) {
    this._soundtouch.pitchSemitones = semitone
  }
  set rate(rate) {
    this._soundtouch.rate = rate
  }
  set tempo(tempo) {
    this._soundtouch.tempo = tempo
  }
  connect(toNode) {
    this._node.connect(toNode)
  }
  disconnect() {
    this._node.disconnect()
  }
  on(eventName, cb) {
    this.listeners.push({
      name: eventName,
      cb: cb
    })
    this._node.addEventListener(eventName, (event) => cb(event.detail))
  }
  off(eventName = null) {
    let listeners = this.listeners
    if (eventName) {
      listeners = listeners.filter((e) => e.name === eventName)
    }
    listeners.forEach((e) => {
      this._node.removeEventListener(e.name, (event) => e.cb(event.detail))
    })
  }
}

//# sourceMappingURL=soundtouch.js.map

/*
 * ---------------------------------------------------------------------------
 * karaoke-player pitch-shift AudioWorkletProcessor (부속 코드, 위는 soundtouchjs 원본)
 *
 * 인서트 이펙트 방식: 입력(믹스 버스)을 내부 FIFO에 쌓고 SoundTouch(tempo=1,
 * pitch=2^(semitones/12)) 파이프라인으로 뽑아 출력한다. 소스 노드/재생 위치는
 * 건드리지 않으므로 재생 중 키 변경에도 트랜스포트 위치가 유지된다 (S6 DoD).
 * 반음 0일 때도 파이프라인을 유지해(near-identity) 경로 전환 클릭을 피한다.
 * ---------------------------------------------------------------------------
 */

const BLOCK_FRAMES = 128
const COMPACT_MARGIN_FRAMES = 8192

/** SimpleFilter가 절대 프레임 위치로 읽어가는 스트리밍 입력 버퍼 (인터리브 스테레오) */
class StreamSource {
  constructor() {
    this.capacityFrames = 65536
    this.buffer = new Float32Array(this.capacityFrames * 2)
    this.startFrame = 0
    this.lengthFrames = 0
    this.consumedFrame = 0
  }

  push(left, right) {
    const n = left.length
    if (this.lengthFrames + n > this.capacityFrames) this._compact()
    if (this.lengthFrames + n > this.capacityFrames) this._grow(this.lengthFrames + n)
    const base = this.lengthFrames * 2
    for (let i = 0; i < n; i++) {
      this.buffer[base + i * 2] = left[i]
      this.buffer[base + i * 2 + 1] = right[i]
    }
    this.lengthFrames += n
  }

  /** soundtouchjs SimpleFilter 소스 계약: 절대 프레임 position부터 최대 numFrames 복사 */
  extract(target, numFrames, position) {
    const end = this.startFrame + this.lengthFrames
    if (position >= end) return 0
    const frames = Math.min(numFrames, end - position)
    const offset = (position - this.startFrame) * 2
    target.set(this.buffer.subarray(offset, offset + frames * 2))
    return frames
  }

  markConsumed(absFrame) {
    this.consumedFrame = absFrame
  }

  _compact() {
    const keepFrom = Math.max(this.startFrame, this.consumedFrame - COMPACT_MARGIN_FRAMES)
    const drop = keepFrom - this.startFrame
    if (drop <= 0) return
    this.buffer.copyWithin(0, drop * 2, this.lengthFrames * 2)
    this.startFrame += drop
    this.lengthFrames -= drop
  }

  _grow(minFrames) {
    let capacity = this.capacityFrames
    while (capacity < minFrames) capacity *= 2
    const next = new Float32Array(capacity * 2)
    next.set(this.buffer.subarray(0, this.lengthFrames * 2))
    this.buffer = next
    this.capacityFrames = capacity
  }
}

const LATENCY_REPORT_INTERVAL_QUANTA = 64
// 원본 auto 값(약 110/22ms) 대비 축소 — 지연 감소 우선, 노래방 용도 품질 허용 범위
const STRETCH_SEQUENCE_MS = 40
const STRETCH_SEEKWINDOW_MS = 15
const STRETCH_OVERLAP_MS = 8
/* 출력 시작 전 이만큼 입력을 모아, 재생 중 outputBuffer가 바닥나는 일이 없게 한다.
 * 처리 배치(FILL_BATCH_FRAMES) + 여유 마진. 산출물을 버리는 방식의 드리프트 보정은
 * 재충전 공백을 오판해 오디오를 깎아먹으므로 쓰지 않는다 — 남는 지연 변화는
 * latencySec 실측 보고를 통해 메인 스레드의 위치 보정이 흡수한다. */
/* 2026-09-03: 1024 여유로는 rate 1(원키) 경로에서 첫 배치 소진 뒤 입력이 모자라 언더런이 났다
 * (안정 상태 체류 5713 프레임 실측). 3072 여유(7168 프레임 ≈ 163 ms)면 ±6 반음 전부 무음 0. */
const PRIME_FRAMES = FILL_BATCH_FRAMES + 3072
/* reset(시크·정지) 시 잔류 출력을 즉시 버리면 출력단에서 하드 컷이 난다.
 * 이만큼의 쿼텀 동안 1→0 램프로 내보낸 뒤 파이프라인을 새로 만든다 (3 쿼텀 ≈ 9 ms @ 44.1 kHz). */
const DRAIN_QUANTA = 3
/* 시크 프리롤 앞부분 페이드 인 (파형 중간 시작 클릭 방지) */
const SEEK_FADE_FRAMES = Math.round(0.01 * sampleRate)

class SoundTouchWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.pitchSemitones = 0
    this.drainQuanta = 0
    /** 예약된 시크 전환 {left, right, liveAt, marginFrames, primeFrames} — process()가 liveAt 블록에서 적용 */
    this.pendingSeek = null
    this.interleaved = new Float32Array(BLOCK_FRAMES * 2)
    this.silence = new Float32Array(BLOCK_FRAMES)
    this._rebuildPipeline()
    this.port.onmessage = (event) => {
      const data = event.data || {}
      if (typeof data.pitchSemitones === 'number') {
        this.pitchSemitones = Math.max(-6, Math.min(6, data.pitchSemitones))
        this.st.pitchSemitones = this.pitchSemitones
      }
      if (data.seek) {
        this.pendingSeek = data.seek
        this.drainQuanta = 0
      }
      if (data.reset) {
        this.pendingSeek = null
        // 출력 중이면 램프로 비우고, 아직 프라이밍 중이면 바로 재구성
        if (this.warm) this.drainQuanta = DRAIN_QUANTA
        else this._rebuildPipeline()
      }
    }
    this.port.postMessage({ primeFrames: PRIME_FRAMES })
  }

  /** 시크/정지 등 불연속 지점에서 잔류 오디오를 버리고 정렬을 처음부터 다시 잡는다 */
  _rebuildPipeline() {
    this.source = new StreamSource()
    this.st = new SoundTouch()
    this.st.tempo = 1
    this.st.pitch = 1
    this.st.stretch.setParameters(
      sampleRate,
      STRETCH_SEQUENCE_MS,
      STRETCH_SEEKWINDOW_MS,
      STRETCH_OVERLAP_MS
    )
    if (this.pitchSemitones !== 0) this.st.pitchSemitones = this.pitchSemitones
    this.filter = new SimpleFilter(this.source, this.st)
    this.warm = false
    this.drainQuanta = 0
    this.inputFrames = 0
    this.producedFrames = 0
    this.quantum = 0
  }

  /**
   * 예약된 시크 전환. k = 이 블록 첫 프레임의 liveAt 기준 프레임 오프셋(−BLOCK+1 이상).
   * 파이프라인을 새로 만들고 프리롤 중 [X0+k, X0+prime+max(k,0)) 구간을 넣은 뒤, 이 블록의 라이브 입력에서
   * liveAt 이후 부분을 이어 붙인다. 라이브 소스가 콘텐츠 X0+prime에서 정확히 liveAt에 시작하므로 연속이다.
   */
  _switchToSeek(seek, k, left, right) {
    this._rebuildPipeline()
    const start = seek.marginFrames + k
    const end = seek.marginFrames + seek.primeFrames + Math.max(k, 0)
    const s = Math.max(0, Math.min(start, seek.left.length))
    const e = Math.max(s, Math.min(end, seek.left.length))
    if (e > s) {
      const pl = seek.left.subarray(s, e)
      const pr = seek.right.subarray(s, e)
      const fade = Math.min(SEEK_FADE_FRAMES, pl.length)
      for (let i = 0; i < fade; i++) {
        const g = i / fade
        pl[i] *= g
        pr[i] *= g
      }
      this.source.push(pl, pr)
    }
    const liveFrom = Math.min(left.length, Math.max(0, -k))
    if (liveFrom < left.length) this.source.push(left.subarray(liveFrom), right.subarray(liveFrom))
    this.inputFrames = this.source.lengthFrames
    this.warm = this.inputFrames >= PRIME_FRAMES
    // 지연이 바뀌었으니 이 블록에서 바로 보고한다
    this.quantum = LATENCY_REPORT_INTERVAL_QUANTA - 1
  }

  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]
    if (!output || output.length === 0) return true

    const left = input && input.length > 0 ? input[0] : this.silence
    const right = input && input.length > 1 ? input[1] : left
    const n = left.length
    let rampFrom = 1
    let rampTo = 1
    let rebuildAfter = false

    if (this.pendingSeek) {
      const k = Math.round((currentTime - this.pendingSeek.liveAt) * sampleRate)
      if (k + n > 0) {
        this._switchToSeek(this.pendingSeek, k, left, right)
        this.pendingSeek = null
      } else {
        this.source.push(left, right)
        this.inputFrames += n
        // 전환 직전 DRAIN_QUANTA 블록 동안 이전 출력을 램프로 내린다
        const span = DRAIN_QUANTA * n
        if (-k <= span) {
          rampFrom = Math.min(1, -k / span)
          rampTo = Math.max(0, (-k - n) / span)
        }
      }
    } else {
      this.source.push(left, right)
      this.inputFrames += n
      if (this.drainQuanta > 0) {
        rampFrom = this.drainQuanta / DRAIN_QUANTA
        rampTo = (this.drainQuanta - 1) / DRAIN_QUANTA
        rebuildAfter = --this.drainQuanta === 0
      }
    }

    const outL = output[0]
    const outR = output.length > 1 ? output[1] : output[0]

    // 프라이밍: 충분히 모이기 전에는 무음 출력 (시작 지연으로 계산되어 위치 보정됨)
    if (!this.warm) {
      if (this.inputFrames < PRIME_FRAMES) {
        outL.fill(0)
        outR.fill(0)
        return true
      }
      this.warm = true
    }

    const frames = this.filter.extract(this.interleaved, BLOCK_FRAMES)
    this.producedFrames += frames
    for (let i = 0; i < outL.length; i++) {
      if (i < frames) {
        outL[i] = this.interleaved[i * 2]
        outR[i] = this.interleaved[i * 2 + 1]
      } else {
        outL[i] = 0
        outR[i] = 0
      }
    }
    if (rampFrom !== 1 || rampTo !== 1) {
      for (let i = 0; i < outL.length; i++) {
        const g = rampFrom + ((rampTo - rampFrom) * i) / outL.length
        outL[i] *= g
        outR[i] *= g
      }
    }
    if (rebuildAfter) {
      this._rebuildPipeline()
      return true
    }
    this.source.markConsumed(this.filter.sourcePosition)

    // 파이프라인 내 체류 프레임 = 청감 지연. 메인 스레드가 위치 보고에서 차감한다.
    if (++this.quantum % LATENCY_REPORT_INTERVAL_QUANTA === 0 && this.warm) {
      this.port.postMessage({
        latencySec: Math.max(0, this.inputFrames - this.producedFrames) / sampleRate
      })
    }
    return true
  }
}

registerProcessor('soundtouch-processor', SoundTouchWorkletProcessor)
