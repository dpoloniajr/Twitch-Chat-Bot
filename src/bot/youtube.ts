/**
 * YOUTUBE API INTEGRATION: URL parsing, duration formatting, and the Data API
 * calls (video metadata with a one-hour cache, search).
 */

import type { AxiosInstance } from 'axios';
import type { HttpError } from './context';

// YouTube API configuration
export const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
export const YOUTUBE_VIDEO_ENDPOINT = `${YOUTUBE_API_BASE}/videos`;
export const YOUTUBE_SEARCH_ENDPOINT = `${YOUTUBE_API_BASE}/search`;
export const YOUTUBE_CHANNELS_ENDPOINT = `${YOUTUBE_API_BASE}/channels`;

// YouTube metadata cache (TTL: 1 hour)
const YOUTUBE_CACHE_TTL = 60 * 60 * 1000; // 1 hour

export interface YouTubeMetadata {
  videoId: string;
  title: string;
  channelTitle: string;
  channelId: string;
  durationSeconds: number;
  durationFormatted: string;
  thumbnail: string;
}

/**
 * Extract video ID from YouTube URL or return the input if it's already an ID
 * @param input - YouTube URL or video ID
 * @returns Video ID or null if invalid
 */
export function extractVideoId(input: string | null | undefined): string | null {
  if (!input) return null;

  // Already a video ID (11 characters, alphanumeric with - and _)
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
    return input;
  }

  // Standard URL: youtube.com/watch?v=VIDEO_ID
  const standardMatch = input.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (standardMatch) return standardMatch[1];

  // Short URL: youtu.be/VIDEO_ID
  const shortMatch = input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1];

  // Embed URL: youtube.com/embed/VIDEO_ID
  const embedMatch = input.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
  if (embedMatch) return embedMatch[1];

  return null;
}

/**
 * Check if input is a YouTube URL
 */
export function isYouTubeUrl(input: string | null | undefined): boolean {
  if (!input) return false;
  return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//.test(input);
}

/**
 * Parse ISO 8601 duration to seconds
 * @param duration - ISO 8601 duration (e.g., PT4M13S)
 */
export function parseIsoDuration(duration: string | null | undefined): number {
  if (!duration) return 0;

  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;

  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);

  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Format seconds to HH:MM:SS or MM:SS
 */
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

export interface YouTubeClient {
  apiKey: string;
  getYouTubeMetadata: (videoId: string | null) => Promise<YouTubeMetadata | null>;
  /** Video ids ([] when nothing matched), or null when the search failed */
  searchYouTube: (query: string, maxResults?: number) => Promise<string[] | null>;
  /** Channel id (UC...) for a @handle (with or without the @); null if unknown or the lookup failed */
  resolveChannelHandle: (handle: string) => Promise<string | null>;
}

export function createYouTubeClient(http: AxiosInstance, YOUTUBE_API_KEY: string): YouTubeClient {
  const youtubeMetadataCache = new Map<string, { data: YouTubeMetadata; timestamp: number }>();

  /**
   * Fetch YouTube video metadata from API with caching
   * @returns Video metadata or null if error
   */
  async function getYouTubeMetadata(videoId: string | null): Promise<YouTubeMetadata | null> {
    if (!videoId) return null;
    if (!YOUTUBE_API_KEY) {
      console.error('YouTube API key not configured');
      return null;
    }

    // Check cache first
    const cached = youtubeMetadataCache.get(videoId);
    if (cached && Date.now() - cached.timestamp < YOUTUBE_CACHE_TTL) {
      return cached.data;
    }

    try {
      const response = await http.get(YOUTUBE_VIDEO_ENDPOINT, {
        params: {
          part: 'snippet,contentDetails',
          id: videoId,
          key: YOUTUBE_API_KEY
        }
      });

      if (!response.data.items || response.data.items.length === 0) {
        return null;
      }

      const video = response.data.items[0];
      const durationSeconds = parseIsoDuration(video.contentDetails.duration);
      const metadata: YouTubeMetadata = {
        videoId: video.id,
        title: video.snippet.title,
        channelTitle: video.snippet.channelTitle,
        channelId: video.snippet.channelId,
        durationSeconds,
        durationFormatted: formatDuration(durationSeconds),
        thumbnail: video.snippet.thumbnails.default.url
      };

      // Cache the result
      youtubeMetadataCache.set(videoId, {
        data: metadata,
        timestamp: Date.now()
      });

      return metadata;
    } catch (e) {
      const error = e as HttpError;
      console.error('Error fetching YouTube metadata:', error.message);
      if (error.response?.data?.error) {
        console.error('YouTube API error:', error.response.data.error.message);
      }
      return null;
    }
  }

  /**
   * Search YouTube for videos by query
   * @returns Array of video IDs ([] for no results), or null if the search failed
   */
  async function searchYouTube(query: string, maxResults = 1): Promise<string[] | null> {
    if (!query) return null;
    if (!YOUTUBE_API_KEY) {
      console.error('YouTube API key not configured');
      return null;
    }

    try {
      const response = await http.get(YOUTUBE_SEARCH_ENDPOINT, {
        params: {
          part: 'id',
          q: query,
          type: 'video',
          maxResults,
          key: YOUTUBE_API_KEY
        }
      });

      if (!response.data.items) {
        return [];
      }

      return response.data.items.map((item: { id: { videoId: string } }) => item.id.videoId);
    } catch (e) {
      const error = e as HttpError;
      console.error('Error searching YouTube:', error.message);
      if (error.response?.data?.error) {
        console.error('YouTube API error:', error.response.data.error.message);
      }
      return null;
    }
  }

  async function resolveChannelHandle(handle: string): Promise<string | null> {
    if (!handle) return null;
    if (!YOUTUBE_API_KEY) {
      console.error('YouTube API key not configured');
      return null;
    }

    try {
      const response = await http.get(YOUTUBE_CHANNELS_ENDPOINT, {
        params: {
          part: 'id',
          forHandle: handle.startsWith('@') ? handle : `@${handle}`,
          key: YOUTUBE_API_KEY
        }
      });
      return response.data.items?.[0]?.id || null;
    } catch (e) {
      const error = e as HttpError;
      console.error('Error resolving YouTube channel handle:', error.message);
      if (error.response?.data?.error) {
        console.error('YouTube API error:', error.response.data.error.message);
      }
      return null;
    }
  }

  return { apiKey: YOUTUBE_API_KEY, getYouTubeMetadata, searchYouTube, resolveChannelHandle };
}
