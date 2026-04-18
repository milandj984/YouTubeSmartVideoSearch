# Privacy Policy — YouTube Smart Video Search

**Last updated: April 18, 2026**

## Overview

YouTube Smart Video Search is a Chrome extension that enables AI-powered semantic search inside YouTube videos, letting you jump directly to the exact moment that matches your query. This policy explains what data the extension accesses and how it is handled.

## Data Collected and How It Is Used

### YouTube Video Transcripts
The extension reads the transcript (captions) of the currently open YouTube video directly from the YouTube page DOM. This transcript data is used solely to build a local search index for that video. It is never uploaded to any external server.

### Video Metadata
The extension reads basic video metadata (video ID and title) from the YouTube page in order to identify and cache video data locally. This data never leaves your device.

### AI Model Weights
The extension bundles a pre-trained ONNX AI model (~23 MB) directly within the extension package. The model runs entirely on your device and no data is sent to any external server during inference.

### User Plan Information *(future feature)*
A future version of the extension may offer free and paid subscription tiers with features such as video Q&A and auto-summaries. If implemented, your email address and subscription status will be stored locally and transmitted only to our authentication server.

## Data Storage

All data (transcript chunks, vector embeddings, settings) is stored **locally on your device** using Chrome's IndexedDB and `chrome.storage` APIs. Nothing is uploaded to any server. Each video is processed once and cached; subsequent searches on the same video use the local cache.

## Data Sharing

We do not sell, share, or transmit your personal data to any third parties. All processing happens locally on your device.

## Data Retention and Deletion

All locally stored data can be deleted at any time by uninstalling the extension, which removes all IndexedDB entries and stored settings. Individual video caches are automatically managed using an LRU (least recently used) eviction policy.

## Permissions Justification

| Permission | Reason |
|---|---|
| `activeTab` | Access the currently open YouTube tab to read the video transcript and metadata |
| `scripting` | Inject content scripts into YouTube pages to extract the transcript and control video playback |
| `offscreen` | Run the ONNX embedding model in an isolated offscreen document, keeping the heavy WASM runtime away from the main extension process |
| `host_permissions: https://www.youtube.com/*` | Read transcript and video data from YouTube pages |

## Contact

If you have questions about this policy, contact: djordjevicm984@gmail.com
