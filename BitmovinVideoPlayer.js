/* eslint no-useless-constructor: 0 */
/* eslint new-cap: ["error", { "newIsCap": false }] */
/* global toString, bitmovin */

import VideoPlayer from 'videoplayer'
import Logger from 'Logger'
import { videoAnalyticsHelper } from '../core/video/VideoAnalyticsHelper'
// Bitmovin API Reference https://bitmovin.com/docs/player/api-reference/web

const EVENT_DEBOUNCE_TRESH = 2500
const SCRIPT_URL = '//bitmovin-a.akamaihd.net/bitmovin-player/stable/7/bitmovinplayer.js'
const EVENTS = {
  progress: 'progress',
  playing: 'playing',
  play: 'play',
  pause: 'pause',
  timeupdate: 'timeupdate',
  volumechange: 'volumechange',
  muted: 'muted',
  unmuted: 'unmuted',
  seeking: 'seeking',
  seeked: 'seeked',
  ended: 'ended',
  enterfullscreen: 'enterfullscreen',
  exitfullscreen: 'exitfullscreen',
  ready: 'ready',
  waiting: 'waiting',

  timeintervalupdate: 'timeintervalupdate',
  videoquartilecompleted: 'videoquartilecompleted'
}

export class BitmovinVideoPlayer extends VideoPlayer {
  playing = false
  player = null
  track = videoAnalyticsHelper

  get videoDuration () {
    return this.player.getDuration()
  }

  get currentTime () {
    return this.player.getCurrentTime()
  }

  get viewTime () {
    if (this.startPos) {
      return this.currentTime - this.startPos
    }
  }

  get startPos () {
    return this._startPos
  }

  set startPos (val) {
    this._startPos = val
    return this._startPos
  }

  get videoData () { // override super classes video data
    return {
      id: this.videoId,
      title: this.settings.videoTitle,
      duration: this.videoDuration,
      channel: this.videoChannel,
      program: this.videoProgram,
      datePublished: this.videoDatePublished
    }
  }

  constructor (el, options) {
    super(el, options)
  }

  init () {
    this.selectors = Object.assign(this.selectors, {
      blockName: '.BitmovinVideoPlayer'
    })

    // The following attributes are needed for the bitmovin JS to load the proper JS/CSS for their player
    this.playerTarget = this.el.querySelector(`${this.selectors.blockName}-player`)
    this.playerTarget.id = `${this.videoId}_${VideoPlayer.genUniqueId()}`
    this.accountId = this.el.getAttribute('data-account') || false
    this.videoChannel = this.el.getAttribute('data-video-channel')
    this.videoProgram = this.el.getAttribute('data-video-program')
    this.videoDatePublished = this.el.getAttribute('data-date-published')
    if (this.accountId) {
      if (window.bitmovin) {
        this.startPlayer()
      } else {
        this.loadBitmovinApi()
      }
    } else {
      console.info('Bitmovin Video Player: Cannot play video, no account|key found')
      return false
    }

    super.init()
  }

  set quarterEvent (val) {
    if (val > 94 && val < 100) {
      val = 95
    } else {
      val = val - (val % 25)
    }

    if (val !== this._quarterEvent && val > 0) {
      this._quarterEvent = val
      videoAnalyticsHelper.call(this, `Player ${val}% - VOD`)
    }
    return this._quarterEvent
  }

  get quarterEvent () {
    return this._quarterEvent
  }

  startPlayer () {
    const imaAdTagUrl = this.el.getAttribute('data-ima-adtagurl')

    const analyticsConfig = {
      key: this.el.getAttribute('data-analytics-key') || null,
      videoId: this.videoId,
      title: this.videoId
    }

    this.source = {
      hls: this.el.getAttribute('data-hlsurl') || null,
      poster: this.el.getAttribute('data-video-poster') || null
    }
    const config = {
      key: this.accountId,
      source: this.source,
      analytics: analyticsConfig
    }
    if (this.el.closest('.VideoPage-player, .LeadList-lead')) {
      config.playback = {
        autoplay: !(!!navigator.platform && /iPad|iPhone|iPod/.test(navigator.platform))
      }
    }
    if (imaAdTagUrl) {
      config.advertising = {
        admessage: 'Puedes saltar el anuncio en {remainingTime} segundos',
        skipmessage: {
          countdown: 'Puedes saltar el anuncio en {remainingTime} segundos',
          skip: 'Saltar anuncio'
        },
        client: 'ima',
        tag: decodeURI(imaAdTagUrl)
      }
    }
    Logger.info('BSP Video Bitmovin Config', config)
    this.player = bitmovin.player(this.playerTarget.id)
    this.player.setup(config).then(
      () => {
        videoAnalyticsHelper.call(this, 'Player Impressions')

        this.playEventBlock = true
        this.pauseEventBlock = false

        this.on(EVENTS.playing, () => {
          if (this.player.isPlaying()) {
            if (this.player.isAd()) {
              videoAnalyticsHelper.call(this, 'AD -  Started Preroll')
            } else {
              if (!this._firstPlay) {
                this._firstPlay = true
                videoAnalyticsHelper.call(this, 'Player - VOD Video Views')
              } else if (!this.playEventBlock) {
                videoAnalyticsHelper.call(this, 'Player - Play Action')
              }
            }
            this.playEventBlock = true
            clearTimeout(this.playEventTimeout)
            this.playEventTimeout = setTimeout(() => {
              this.playEventBlock = false
            }, EVENT_DEBOUNCE_TRESH)
          }
        })

        this.on(EVENTS.pause, () => {
          if (this.player.isPlaying()) {
            const curTime = this.currentTime
            if (Math.floor(curTime) < Math.floor(this.videoDuration)) {
              if (!this.pauseEventBlock) {
                videoAnalyticsHelper.call(this, 'Player - Pause Action')
              }
              this.pauseEventBlock = true
              clearTimeout(this.pauseEventTimeout)
              this.pauseEventTimeout = setTimeout(() => {
                this.pauseEventBlock = false
              }, EVENT_DEBOUNCE_TRESH)
            }
          }
        })
        this.on(EVENTS.timeupdate, (e) => {
          const percentage = (e.secondsElapsed * 100) / this.videoDuration
          this.quarterEvent = percentage
        })
      }
    )

    if (!('bspPlayers' in window)) {
      window.bspPlayers = []
    }
    window.bspPlayers.push(this)

    this.player.addEventHandler(bitmovin.player.EVENT.ON_READY, (e) => {
      super.onVideoReady(e)
      this._ready = true
    })

    this.player.addEventHandler(bitmovin.player.EVENT.ON_PLAYING, this.onPlayerPlay.bind(this))
    this.player.addEventHandler(bitmovin.player.EVENT.ON_PAUSED, this.onPlayerPaused.bind(this))
    this.player.addEventHandler(bitmovin.player.EVENT.ON_TIME_CHANGED, this.onPlayerTimeChange.bind(this))
    this.player.addEventHandler(bitmovin.player.EVENT.ON_AD_FINISHED, () => {
      videoAnalyticsHelper.call(this, 'AD - Ended Preroll')
    })
    this.player.addEventHandler(bitmovin.player.EVENT.ON_AD_QUARTILE, (e) => {
      if (e && e.quartile) {
        const quartileMap = {
          firstQuartile: 25,
          midpoint: 50,
          thirdQuartile: 75
        }
        videoAnalyticsHelper.call(this, `AD - ${quartileMap[e.quartile]}% Preroll`)
      }
    })
    this.player.addEventHandler(bitmovin.player.EVENT.ON_ERROR, (e) => {
      videoAnalyticsHelper.call(this, 'Player Error')
    })
  }

  onPlayerPlay (e) {
    super.onVideoStart(e)
  }

  onPlayerPaused (e) {
    super.onVideoPause(e)
  }

  onPlayerTimeChange (e) {
    e.secondsElapsed = e.time
    super.onVideoTimeUpdate(e)
  }

  onPlayerEnded (e) {
    super.onVideoEnd(e)
  }

  loadBitmovinApi (accountId, playerId) {
    const tag = document.createElement('script')
    tag.src = SCRIPT_URL
    tag.addEventListener('load', this.startPlayer.bind(this))
    document.head.insertBefore(tag, document.head.getElementsByTagName('script')[0])
  }

  play () {
    this.player.play()
  }

  pause () {
    this.player.pause()
  }
}
