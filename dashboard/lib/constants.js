const path = require('path');

const SUPPORTED_IMAGE_TYPES = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const SUPPORTED_VIDEO_TYPES = ['.mp4', '.webm', '.mov'];
const SUPPORTED_AUDIO_TYPES = ['.mp3', '.ogg', '.wav', '.m4a'];

const MIME_SIGNATURES = {
  '.png': [0x89, 0x50, 0x4e, 0x47],
  '.jpg': [0xff, 0xd8, 0xff],
  '.jpeg': [0xff, 0xd8, 0xff],
  '.gif': [0x47, 0x49, 0x46],
  '.webp': [0x52, 0x49, 0x46, 0x46],
  '.mp4': [0x66, 0x74, 0x79, 0x70],
  '.webm': [0x1a, 0x45, 0xdf, 0xa3],
  '.mov': [0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70],
  '.mp3': [0x49, 0x44, 0x33],
  '.ogg': [0x4f, 0x67, 0x67, 0x53],
  '.wav': [0x52, 0x49, 0x46, 0x46],
  '.m4a': [0x66, 0x74, 0x79, 0x70]
};

const DEFAULT_ALERT_CONFIG = {
  global: {
    enabled: true,
    testMode: false,
    defaultVolume: 0.8,
    defaultDuration: 5,
    defaultDelay: 1,
    ttsEnabled: false,
    ttsVoice: 'en-US',
    ttsRate: 1.0,
    ttsPitch: 1.0
  },
  alertTypes: {
    follow: {
      enabled: true,
      duration: 5,
      volume: 0.8,
      enterAnimation: 'bounceIn',
      exitAnimation: 'fadeOutUp',
      layout: 'standard',
      showMessage: true,
      ttsEnabled: false,
      ttsTemplate: '{user} just followed!',
      sound: 'default',
      customSound: null,
      image: null,
      video: null,
      textColor: '#00ff7f',
      backgroundColor: 'rgba(30, 30, 30, 0.95)',
      borderColor: '#00ff7f',
      fontFamily: 'Segoe UI',
      fontSize: 28,
      messageTemplate: 'New Follower!'
    },
    subscription: {
      enabled: true,
      duration: 6,
      volume: 0.8,
      enterAnimation: 'bounceIn',
      exitAnimation: 'fadeOutUp',
      layout: 'standard',
      showMessage: true,
      ttsEnabled: false,
      ttsTemplate: '{user} just subscribed!',
      sound: 'default',
      customSound: null,
      image: null,
      video: null,
      textColor: '#ff6b9d',
      backgroundColor: 'rgba(30, 30, 30, 0.95)',
      borderColor: '#ff6b9d',
      fontFamily: 'Segoe UI',
      fontSize: 28,
      messageTemplate: 'New Subscriber!',
      variations: {
        prime: { enabled: true, sound: null, image: null, messageTemplate: 'Prime Subscriber!' },
        tier1: { enabled: true, sound: null, image: null, messageTemplate: 'Tier 1 Subscriber!' },
        tier2: { enabled: true, sound: null, image: null, messageTemplate: 'Tier 2 Subscriber!' },
        tier3: { enabled: true, sound: null, image: null, messageTemplate: 'Tier 3 Subscriber!' },
        gift: { enabled: true, sound: null, image: null, messageTemplate: 'Gifted Sub!' },
        communityGift: { enabled: true, sound: null, image: null, messageTemplate: 'Community Gift!' },
        resub: { enabled: true, sound: null, image: null, messageTemplate: 'Resubscribed!' }
      }
    },
    bits: {
      enabled: true,
      duration: 5,
      volume: 0.8,
      enterAnimation: 'bounceIn',
      exitAnimation: 'fadeOutUp',
      layout: 'standard',
      showMessage: true,
      ttsEnabled: false,
      ttsTemplate: '{user} cheered {amount} bits!',
      sound: 'default',
      customSound: null,
      image: null,
      video: null,
      textColor: '#ffbb00',
      backgroundColor: 'rgba(30, 30, 30, 0.95)',
      borderColor: '#ffbb00',
      fontFamily: 'Segoe UI',
      fontSize: 28,
      messageTemplate: 'Cheer!',
      minBits: 1,
      variations: {
        '1': { enabled: true, sound: null, image: null, messageTemplate: 'Cheer!' },
        '100': { enabled: true, sound: null, image: null, messageTemplate: 'Big Cheer!' },
        '1000': { enabled: true, sound: null, image: null, messageTemplate: 'Huge Cheer!' },
        '5000': { enabled: true, sound: null, image: null, messageTemplate: 'Massive Cheer!' },
        '10000': { enabled: true, sound: null, image: null, messageTemplate: 'Legendary Cheer!' }
      }
    },
    raid: {
      enabled: true,
      duration: 7,
      volume: 0.8,
      enterAnimation: 'bounceIn',
      exitAnimation: 'fadeOutUp',
      layout: 'standard',
      showMessage: true,
      ttsEnabled: false,
      ttsTemplate: '{user} is raiding with {viewers} viewers!',
      sound: 'default',
      customSound: null,
      image: null,
      video: null,
      textColor: '#00d4ff',
      backgroundColor: 'rgba(30, 30, 30, 0.95)',
      borderColor: '#00d4ff',
      fontFamily: 'Segoe UI',
      fontSize: 28,
      messageTemplate: 'Raid!',
      minViewers: 2,
      variations: {
        '2': { enabled: true, sound: null, image: null, messageTemplate: 'Raid!' },
        '10': { enabled: true, sound: null, image: null, messageTemplate: 'Big Raid!' },
        '50': { enabled: true, sound: null, image: null, messageTemplate: 'Huge Raid!' },
        '100': { enabled: true, sound: null, image: null, messageTemplate: 'Massive Raid!' }
      }
    },
    redemption: {
      enabled: true,
      duration: 5,
      volume: 0.8,
      enterAnimation: 'bounceIn',
      exitAnimation: 'fadeOutUp',
      layout: 'standard',
      showMessage: true,
      ttsEnabled: false,
      ttsTemplate: '{user} redeemed {reward}!',
      sound: 'default',
      customSound: null,
      image: null,
      video: null,
      textColor: '#9147ff',
      backgroundColor: 'rgba(30, 30, 30, 0.95)',
      borderColor: '#9147ff',
      fontFamily: 'Segoe UI',
      fontSize: 28,
      messageTemplate: 'Redemption!',
      customRewards: {}
    }
  }
};

const ANIMATIONS = {
  enter: [
    { value: 'fadeIn', label: 'Fade In' },
    { value: 'fadeInUp', label: 'Fade In Up' },
    { value: 'fadeInDown', label: 'Fade In Down' },
    { value: 'slideInLeft', label: 'Slide In Left' },
    { value: 'slideInRight', label: 'Slide In Right' },
    { value: 'scaleIn', label: 'Scale In' },
    { value: 'bounceIn', label: 'Bounce In' },
    { value: 'rotateIn', label: 'Rotate In' }
  ],
  exit: [
    { value: 'fadeOut', label: 'Fade Out' },
    { value: 'fadeOutUp', label: 'Fade Out Up' },
    { value: 'fadeOutDown', label: 'Fade Out Down' },
    { value: 'slideOutLeft', label: 'Slide Out Left' },
    { value: 'slideOutRight', label: 'Slide Out Right' },
    { value: 'scaleOut', label: 'Scale Out' }
  ]
};

const TTS_VOICES = [
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'en-AU', label: 'English (Australia)' },
  { value: 'es-ES', label: 'Spanish (Spain)' },
  { value: 'es-MX', label: 'Spanish (Mexico)' },
  { value: 'fr-FR', label: 'French' },
  { value: 'de-DE', label: 'German' },
  { value: 'it-IT', label: 'Italian' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)' },
  { value: 'ja-JP', label: 'Japanese' },
  { value: 'ko-KR', label: 'Korean' }
];

const UPLOAD_LIMIT_WINDOW = 60000;
const UPLOAD_LIMIT_COUNT = 10;

module.exports = {
  SUPPORTED_IMAGE_TYPES,
  SUPPORTED_VIDEO_TYPES,
  SUPPORTED_AUDIO_TYPES,
  MIME_SIGNATURES,
  DEFAULT_ALERT_CONFIG,
  ANIMATIONS,
  TTS_VOICES,
  UPLOAD_LIMIT_WINDOW,
  UPLOAD_LIMIT_COUNT
};
