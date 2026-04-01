import { describe, it, expect } from 'vitest';
import {
  isSupportedImageFormat,
  getMediaType,
  getSupportedFormatsMessage,
  containsImageFiles,
} from '../imageFormat.js';

describe('isSupportedImageFormat', () => {
  it.each([
    ['image.png', true],
    ['image.jpg', true],
    ['image.jpeg', true],
    ['image.gif', true],
    ['image.webp', true],
  ])('%s はサポート対象である', (filePath, expected) => {
    expect(isSupportedImageFormat(filePath)).toBe(expected);
  });

  it.each([
    ['image.svg', false],
    ['image.bmp', false],
    ['image.tiff', false],
    ['document.txt', false],
    ['code.ts', false],
    ['archive.zip', false],
  ])('%s はサポート対象外である', (filePath, expected) => {
    expect(isSupportedImageFormat(filePath)).toBe(expected);
  });

  it('大文字の拡張子もサポートされる', () => {
    expect(isSupportedImageFormat('image.PNG')).toBe(true);
    expect(isSupportedImageFormat('image.Jpg')).toBe(true);
    expect(isSupportedImageFormat('image.WEBP')).toBe(true);
  });

  it('パス付きファイルの拡張子を正しく判定する', () => {
    expect(isSupportedImageFormat('/path/to/image.png')).toBe(true);
    expect(isSupportedImageFormat('src/assets/logo.svg')).toBe(false);
  });
});

describe('getMediaType', () => {
  it.each([
    ['image.png', 'image/png'],
    ['image.jpg', 'image/jpeg'],
    ['image.jpeg', 'image/jpeg'],
    ['image.gif', 'image/gif'],
    ['image.webp', 'image/webp'],
  ])('%s のメディアタイプは %s である', (filePath, expected) => {
    expect(getMediaType(filePath)).toBe(expected);
  });

  it('サポート外の形式ではnullを返す', () => {
    expect(getMediaType('image.svg')).toBeNull();
    expect(getMediaType('document.txt')).toBeNull();
  });

  it('大文字の拡張子でも正しいメディアタイプを返す', () => {
    expect(getMediaType('image.PNG')).toBe('image/png');
    expect(getMediaType('image.JPEG')).toBe('image/jpeg');
  });
});

describe('getSupportedFormatsMessage', () => {
  it('サポート形式名を全て含む', () => {
    const message = getSupportedFormatsMessage();
    expect(message).toContain('PNG');
    expect(message).toContain('JPEG');
    expect(message).toContain('GIF');
    expect(message).toContain('WebP');
  });
});

describe('containsImageFiles', () => {
  it('画像ファイルを含むfolderTreeでtrueを返す', () => {
    const folderTree = `src/
  index.ts
  assets/
    logo.png
    style.css`;
    expect(containsImageFiles(folderTree)).toBe(true);
  });

  it('複数の画像形式を検出する', () => {
    expect(containsImageFiles('docs/screenshot.jpg')).toBe(true);
    expect(containsImageFiles('assets/icon.gif')).toBe(true);
    expect(containsImageFiles('images/photo.webp')).toBe(true);
    expect(containsImageFiles('assets/banner.jpeg')).toBe(true);
  });

  it('画像ファイルを含まないfolderTreeでfalseを返す', () => {
    const folderTree = `src/
  index.ts
  utils/
    helper.ts
  package.json`;
    expect(containsImageFiles(folderTree)).toBe(false);
  });

  it('空文字列でfalseを返す', () => {
    expect(containsImageFiles('')).toBe(false);
  });

  it('大文字の拡張子でもtrueを返す', () => {
    expect(containsImageFiles('assets/LOGO.PNG')).toBe(true);
  });
});
