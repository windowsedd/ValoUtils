// ============================================================================
// Crosshair SVG Generator — React Component (.tsx) — Single-file, zero deps beyond React
//
// Usage:
//   import {
//     CrosshairSVG,
//     SniperCrosshairSVG,
//     CrosshairFromCode,
//     useCrosshairSettings,
//     generateCrosshairFromCode,
//     generateCrosshair,
//     generateSVGString,
//     generateSVGFromCode,
//   } from './crosshair-svg-generator';
//
//   // React component from a crosshair code
//   <CrosshairFromCode code="0;P;c;5;h;0;0l;4;0o;2;0a;1;0f;0;1b;0" />
//
//   // React component from settings
//   <CrosshairSVG settings={myPrimarySettings} />
//
//   // Sniper dot
//   <SniperCrosshairSVG settings={mySniperSettings} />
//
//   // Hook for parsed settings
//   const settings = useCrosshairSettings('0;P;c;5;h;0;...');
//
//   // Pure string generation (no React needed)
//   const svgString = generateSVGFromCode('0;P;c;5;h;0;...');
// ============================================================================

import React, { useMemo } from 'react';

// ---------------------------------------------------------------------------
// Preset Colors
// ---------------------------------------------------------------------------

export enum PresetColors {
  White = '#FFFFFF',
  Green = '#00FF00',
  YellowGreen = '#7FFF00',
  GreenYellow = '#DFFF00',
  Yellow = '#FFFF00',
  Cyan = '#00FFFF',
  Pink = '#FF00FF',
  Red = '#FF0000',
}

export const CROSSHAIR_COLORS: Record<string, string> = {
  [PresetColors.White]: 'White',
  [PresetColors.Green]: 'Green',
  [PresetColors.YellowGreen]: 'Yellow Green',
  [PresetColors.GreenYellow]: 'Green Yellow',
  [PresetColors.Yellow]: 'Yellow',
  [PresetColors.Cyan]: 'Cyan',
  [PresetColors.Pink]: 'Pink',
  [PresetColors.Red]: 'Red',
};

// ---------------------------------------------------------------------------
// Mapping Enums (Valorant crosshair code keys)
// ---------------------------------------------------------------------------

export enum GeneralMapping {
  OVERRIDE_ALL_PRIMARY_CROSSHAIRS_WITH_PRIMARY_CROSSHAIR = 'c',
}

export enum PrimaryMapping {
  CROSSHAIR_COLOR = 'c',
  CUSTOM_COLOR = 'u',
  OUTLINES = 'h',
  OUTLINE_THICKNESS = 't',
  OUTLINE_OPACITY = 'o',
  CENTER_DOT = 'd',
  OVERRIDE_FIRING_ERROR_OFFSET_WITH_CROSSHAIR_OFFSET = 'm',
  CENTER_DOT_THICKNESS = 'z',
  CENTER_DOT_OPACITY = 'a',
}

export enum LineMapping {
  SHOW = 'b',
  OPACITY = 'a',
  LENGTH = 'l',
  VERTICAL = 'v',
  LENGTH_NOT_LINKED = 'g',
  THICKNESS = 't',
  OFFSET = 'o',
  MOVEMENT_ERROR = 'm',
  MOVEMENT_ERROR_MULTIPLIER = 's',
  FIRING_ERROR = 'f',
  FIRING_ERROR_MULTIPLIER = 'e',
}

export enum SniperCenterDotMapping {
  SHOW = 'd',
  CUSTOM_COLOR = 't',
  COLOR = 'c',
  THICKNESS = 's',
  OPACITY = 'o',
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface LineSettings {
  [LineMapping.SHOW]: boolean;
  [LineMapping.OPACITY]: number;
  [LineMapping.LENGTH]: number;
  [LineMapping.VERTICAL]: number;
  [LineMapping.LENGTH_NOT_LINKED]: boolean;
  [LineMapping.THICKNESS]: number;
  [LineMapping.OFFSET]: number;
  [LineMapping.MOVEMENT_ERROR]: boolean;
  [LineMapping.MOVEMENT_ERROR_MULTIPLIER]: number;
  [LineMapping.FIRING_ERROR]: boolean;
  [LineMapping.FIRING_ERROR_MULTIPLIER]: number;
}

export interface PrimarySettings {
  [PrimaryMapping.CROSSHAIR_COLOR]: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  [PrimaryMapping.CUSTOM_COLOR]?: string;
  [PrimaryMapping.OUTLINES]: boolean;
  [PrimaryMapping.OUTLINE_OPACITY]: number;
  [PrimaryMapping.OUTLINE_THICKNESS]: number;
  [PrimaryMapping.CENTER_DOT]: boolean;
  [PrimaryMapping.CENTER_DOT_OPACITY]: number;
  [PrimaryMapping.CENTER_DOT_THICKNESS]: number;
  [PrimaryMapping.OVERRIDE_FIRING_ERROR_OFFSET_WITH_CROSSHAIR_OFFSET]: boolean;
  inner_lines: LineSettings;
  outer_lines: LineSettings;
}

export interface SniperSettings {
  [SniperCenterDotMapping.SHOW]: boolean;
  [SniperCenterDotMapping.CUSTOM_COLOR]: string;
  [SniperCenterDotMapping.COLOR]: number;
  [SniperCenterDotMapping.THICKNESS]: number;
  [SniperCenterDotMapping.OPACITY]: number;
}

export interface CrosshairSettings {
  name: string;
  override_all_primary_crosshairs_with_my_primary_crosshair: boolean;
  use_advanced_options: boolean;
  fade_crosshair_with_firing_error: boolean;
  primary: PrimarySettings;
  ads: PrimarySettings;
  ads_copy_primary: boolean;
  sniper: SniperSettings;
}

// ---------------------------------------------------------------------------
// Label Maps (useful for UI builders)
// ---------------------------------------------------------------------------

export const labelMap: Record<string, string> = {
  [PrimaryMapping.CROSSHAIR_COLOR]: 'Crosshair Color',
  [PrimaryMapping.CUSTOM_COLOR]: 'Custom Color',
  [PrimaryMapping.OUTLINES]: 'Outlines',
  [PrimaryMapping.OUTLINE_OPACITY]: 'Outline Opacity',
  [PrimaryMapping.OUTLINE_THICKNESS]: 'Outline Thickness',
  [PrimaryMapping.CENTER_DOT]: 'Center Dot',
  [PrimaryMapping.CENTER_DOT_OPACITY]: 'Center Dot Opacity',
  [PrimaryMapping.CENTER_DOT_THICKNESS]: 'Center Dot Thickness',
  [PrimaryMapping.OVERRIDE_FIRING_ERROR_OFFSET_WITH_CROSSHAIR_OFFSET]:
    'Override Firing Error Offset With Crosshair Offset',
};

export const innerlineLabelMap: Record<string, string> = {
  [LineMapping.SHOW]: 'Show Inner Lines',
  [LineMapping.OPACITY]: 'Inner Line Opacity',
  [LineMapping.LENGTH]: 'Inner Line Length',
  [LineMapping.VERTICAL]: 'Vertical',
  [LineMapping.LENGTH_NOT_LINKED]: 'Length Is Linked',
  [LineMapping.THICKNESS]: 'Inner Line Thickness',
  [LineMapping.OFFSET]: 'Inner Line Offset',
  [LineMapping.MOVEMENT_ERROR]: 'Movement Error',
  [LineMapping.MOVEMENT_ERROR_MULTIPLIER]: 'Movement Error Multiplier',
  [LineMapping.FIRING_ERROR]: 'Firing Error',
  [LineMapping.FIRING_ERROR_MULTIPLIER]: 'Firing Error Multiplier',
};

export const outerlineLabelMap: Record<string, string> = {
  [LineMapping.SHOW]: 'Show Outer Lines',
  [LineMapping.OPACITY]: 'Outer Line Opacity',
  [LineMapping.LENGTH]: 'Outer Line Length',
  [LineMapping.VERTICAL]: 'Vertical',
  [LineMapping.LENGTH_NOT_LINKED]: 'Length Is Linked',
  [LineMapping.THICKNESS]: 'Outer Line Thickness',
  [LineMapping.OFFSET]: 'Outer Line Offset',
  [LineMapping.MOVEMENT_ERROR]: 'Movement Error',
  [LineMapping.MOVEMENT_ERROR_MULTIPLIER]: 'Movement Error Multiplier',
  [LineMapping.FIRING_ERROR]: 'Firing Error',
  [LineMapping.FIRING_ERROR_MULTIPLIER]: 'Firing Error Multiplier',
};

// ---------------------------------------------------------------------------
// Deep Clone & Deep Equal helpers (replaces lodash)
// ---------------------------------------------------------------------------

function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((item) => deepClone(item)) as unknown as T;
  const cloned: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    cloned[key] = deepClone((obj as Record<string, unknown>)[key]);
  }
  return cloned as T;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
      return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Default Settings
// ---------------------------------------------------------------------------

const DEFAULT_PRIMARY_SETTINGS: PrimarySettings = {
  [PrimaryMapping.CROSSHAIR_COLOR]: 0,
  [PrimaryMapping.CUSTOM_COLOR]: 'FFFFFF',
  [PrimaryMapping.OUTLINES]: true,
  [PrimaryMapping.OUTLINE_OPACITY]: 0.5,
  [PrimaryMapping.OUTLINE_THICKNESS]: 1,
  [PrimaryMapping.CENTER_DOT]: false,
  [PrimaryMapping.CENTER_DOT_OPACITY]: 1,
  [PrimaryMapping.CENTER_DOT_THICKNESS]: 2,
  [PrimaryMapping.OVERRIDE_FIRING_ERROR_OFFSET_WITH_CROSSHAIR_OFFSET]: false,

  inner_lines: {
    [LineMapping.SHOW]: true,
    [LineMapping.OPACITY]: 0.8,
    [LineMapping.LENGTH]: 6,
    [LineMapping.VERTICAL]: 6,
    [LineMapping.LENGTH_NOT_LINKED]: false,
    [LineMapping.THICKNESS]: 2,
    [LineMapping.OFFSET]: 3,
    [LineMapping.MOVEMENT_ERROR]: false,
    [LineMapping.MOVEMENT_ERROR_MULTIPLIER]: 1,
    [LineMapping.FIRING_ERROR]: true,
    [LineMapping.FIRING_ERROR_MULTIPLIER]: 1,
  },
  outer_lines: {
    [LineMapping.SHOW]: true,
    [LineMapping.OPACITY]: 0.35,
    [LineMapping.LENGTH]: 2,
    [LineMapping.VERTICAL]: 2,
    [LineMapping.LENGTH_NOT_LINKED]: false,
    [LineMapping.THICKNESS]: 2,
    [LineMapping.OFFSET]: 10,
    [LineMapping.MOVEMENT_ERROR]: true,
    [LineMapping.MOVEMENT_ERROR_MULTIPLIER]: 1,
    [LineMapping.FIRING_ERROR]: true,
    [LineMapping.FIRING_ERROR_MULTIPLIER]: 1,
  },
};

export const DEFAULT_SETTINGS: CrosshairSettings = {
  name: 'Crosshair Profile',
  fade_crosshair_with_firing_error: true,
  use_advanced_options: false,
  override_all_primary_crosshairs_with_my_primary_crosshair: false,
  primary: deepClone(DEFAULT_PRIMARY_SETTINGS),
  ads: deepClone(DEFAULT_PRIMARY_SETTINGS),
  ads_copy_primary: true,
  sniper: {
    [SniperCenterDotMapping.SHOW]: true,
    [SniperCenterDotMapping.CUSTOM_COLOR]: 'FF0000',
    [SniperCenterDotMapping.COLOR]: 7,
    [SniperCenterDotMapping.THICKNESS]: 1,
    [SniperCenterDotMapping.OPACITY]: 0.8,
  },
};

// ---------------------------------------------------------------------------
// Code → Settings (Parser)
// ---------------------------------------------------------------------------

export function generateCrosshairFromCode(code: string): CrosshairSettings {
  const settings: any = deepClone(DEFAULT_SETTINGS);
  const parts = code.split(/(P|A|S|NAME);/g);

  if (parts.indexOf('P')) {
    const primary = parts[parts.indexOf('P') + 1].split(';');
    setPrimarySettings('primary', primary);
  }

  if (parts.indexOf('A')) {
    const ads = parts[parts.indexOf('A') + 1].split(';');
    setPrimarySettings('ads', ads);
  }

  if (parts.indexOf('S')) {
    const sniper = parts[parts.indexOf('S') + 1];
    const sniperSettings = settings.sniper;
    const sniperParts = sniper.split(';');
    for (let i = 0; i < sniperParts.length; i += 2) {
      const key = sniperParts[i];
      const value = sniperParts[i + 1];
      typeCheckThenSet(sniperSettings, key, value);
    }
  }

  if (parts.indexOf('NAME') >= 0) {
    const name = parts[parts.indexOf('NAME') + 1];
    settings.name = name.replace(/^"|"$/g, '');
  }

  function setPrimarySettings(type: 'primary' | 'ads', primaryCode: string[]) {
    const primarySettings = settings[type];
    for (let i = 0; i < primaryCode.length; i += 2) {
      const key = primaryCode[i];
      const value = primaryCode[i + 1];
      if (key.startsWith('0') || key.startsWith('1')) {
        const lineSettings: any =
          primarySettings[key.startsWith('0') ? 'inner_lines' : 'outer_lines'];
        const lineKey = key.slice(1) as keyof LineSettings;
        typeCheckThenSet(lineSettings, lineKey, value);
      } else {
        if (key === PrimaryMapping.CROSSHAIR_COLOR) {
          if (value !== '8') {
            let color = Object.keys(CROSSHAIR_COLORS)[+value].replace('#', '');
            if (color.length === 8) {
              color = color.replace(/FF$/, '');
            }
            typeCheckThenSet(primarySettings, PrimaryMapping.CUSTOM_COLOR, color);
          }
        }
        if (
          key === PrimaryMapping.CUSTOM_COLOR &&
          primarySettings[PrimaryMapping.CROSSHAIR_COLOR] !== 8
        ) {
          continue;
        }
        typeCheckThenSet(primarySettings, key, value);
      }
    }
  }

  function typeCheckThenSet(s: any, key: string, value: any) {
    if (typeof s[key] === 'boolean') {
      s[key] = !!+value;
    } else if (typeof s[key] === 'number') {
      s[key] = +value;
    } else if (typeof s[key] === 'string') {
      s[key] = value;
    }
  }

  return settings;
}

// ---------------------------------------------------------------------------
// Settings → Code (Generator)
// ---------------------------------------------------------------------------

export function generateCrosshair(s: CrosshairSettings, withName = false): string {
  if (deepEqual(s, DEFAULT_SETTINGS)) {
    if (withName) {
      return '0;NAME;"' + s.name + '"';
    }
    return '0';
  }

  let code = '0;';

  if (s.use_advanced_options) {
    code += 's;1;';
    if (!s.ads_copy_primary) {
      code += 'p;0;';
    }
  }

  if (!deepEqual(DEFAULT_PRIMARY_SETTINGS, s.primary)) {
    code += 'P;';
  }

  addCrosshairColor('primary');
  addOutlineSettings('primary');
  addCenterDotSettings('primary');
  addLineSettings('primary');
  addLineSettings('primary', true);

  if (s.use_advanced_options && !s.ads_copy_primary) {
    code += 'A;';
    addCrosshairColor('ads');
    addOutlineSettings('ads');
    addCenterDotSettings('ads');
    addLineSettings('ads');
    addLineSettings('ads', true);
  }

  if (s.use_advanced_options && !deepEqual(DEFAULT_SETTINGS.sniper, s.sniper)) {
    code += 'S;';
    const sniper = s.sniper;
    if (sniper[SniperCenterDotMapping.SHOW] === true) {
      appendSetting(SniperCenterDotMapping.OPACITY, sniper[SniperCenterDotMapping.OPACITY]);
      appendSetting(SniperCenterDotMapping.THICKNESS, sniper[SniperCenterDotMapping.THICKNESS]);
      const color = '#' + s.sniper[SniperCenterDotMapping.CUSTOM_COLOR];
      if (CROSSHAIR_COLORS[color as keyof typeof CROSSHAIR_COLORS]) {
        appendSetting(SniperCenterDotMapping.COLOR, Object.keys(CROSSHAIR_COLORS).indexOf(color));
      } else {
        appendSetting(SniperCenterDotMapping.COLOR, 8);
        const c = sniper[SniperCenterDotMapping.CUSTOM_COLOR];
        appendSetting(SniperCenterDotMapping.CUSTOM_COLOR, c.length === 6 ? c + 'FF' : c);
      }
    } else {
      appendSetting(SniperCenterDotMapping.SHOW, +false);
    }
  }

  function addLineSettings(x: 'primary' | 'ads', isOuter = false) {
    const prefix = String(+isOuter);
    const lineSettings = s[x][isOuter ? 'outer_lines' : 'inner_lines'];
    const defaultLineSettings = DEFAULT_PRIMARY_SETTINGS[isOuter ? 'outer_lines' : 'inner_lines'];

    if (lineSettings[LineMapping.SHOW] !== defaultLineSettings[LineMapping.SHOW]) {
      appendSetting(
        (prefix + LineMapping.SHOW) as PrimaryMapping,
        +lineSettings[LineMapping.SHOW]
      );
    } else {
      if (lineSettings[LineMapping.THICKNESS] !== defaultLineSettings[LineMapping.THICKNESS]) {
        appendSetting(
          (prefix + LineMapping.THICKNESS) as PrimaryMapping,
          lineSettings[LineMapping.THICKNESS]
        );
      }
      if (lineSettings[LineMapping.LENGTH] !== defaultLineSettings[LineMapping.LENGTH]) {
        appendSetting(
          (prefix + LineMapping.LENGTH) as PrimaryMapping,
          lineSettings[LineMapping.LENGTH]
        );
      }
      if (lineSettings[LineMapping.LENGTH_NOT_LINKED]) {
        appendSetting(
          (prefix + LineMapping.VERTICAL) as PrimaryMapping,
          lineSettings[LineMapping.VERTICAL]
        );
        appendSetting(
          (prefix + LineMapping.LENGTH_NOT_LINKED) as PrimaryMapping,
          +lineSettings[LineMapping.LENGTH_NOT_LINKED]
        );
      }
      if (lineSettings[LineMapping.OFFSET] !== defaultLineSettings[LineMapping.OFFSET]) {
        appendSetting(
          (prefix + LineMapping.OFFSET) as PrimaryMapping,
          lineSettings[LineMapping.OFFSET]
        );
      }
      if (lineSettings[LineMapping.OPACITY] !== defaultLineSettings[LineMapping.OPACITY]) {
        appendSetting(
          (prefix + LineMapping.OPACITY) as PrimaryMapping,
          lineSettings[LineMapping.OPACITY]
        );
      }
      if (lineSettings[LineMapping.FIRING_ERROR] !== defaultLineSettings[LineMapping.FIRING_ERROR]) {
        appendSetting(
          (prefix + LineMapping.FIRING_ERROR) as PrimaryMapping,
          +lineSettings[LineMapping.FIRING_ERROR]
        );
      }
      if (
        lineSettings[LineMapping.FIRING_ERROR] &&
        lineSettings[LineMapping.FIRING_ERROR_MULTIPLIER] !==
          defaultLineSettings[LineMapping.FIRING_ERROR_MULTIPLIER]
      ) {
        appendSetting(
          (prefix + LineMapping.FIRING_ERROR_MULTIPLIER) as PrimaryMapping,
          lineSettings[LineMapping.FIRING_ERROR_MULTIPLIER]
        );
      }
      if (
        lineSettings[LineMapping.MOVEMENT_ERROR] !== defaultLineSettings[LineMapping.MOVEMENT_ERROR]
      ) {
        appendSetting(
          (prefix + LineMapping.MOVEMENT_ERROR) as PrimaryMapping,
          +lineSettings[LineMapping.MOVEMENT_ERROR]
        );
        if (lineSettings[LineMapping.MOVEMENT_ERROR]) {
          appendSetting(
            (prefix + LineMapping.MOVEMENT_ERROR_MULTIPLIER) as PrimaryMapping,
            lineSettings[LineMapping.MOVEMENT_ERROR_MULTIPLIER]
          );
        }
      }
    }
  }

  function addCrosshairColor(x: 'primary' | 'ads') {
    const color = '#' + s[x][PrimaryMapping.CUSTOM_COLOR];
    if (CROSSHAIR_COLORS[color as keyof typeof CROSSHAIR_COLORS]) {
      if (color !== '#FFFFFF') {
        appendSetting(
          PrimaryMapping.CROSSHAIR_COLOR,
          Object.keys(CROSSHAIR_COLORS).indexOf(color)
        );
      }
    } else {
      appendSetting(PrimaryMapping.CROSSHAIR_COLOR, 8);
      const c = s[x][PrimaryMapping.CUSTOM_COLOR] as string;
      appendSetting(PrimaryMapping.CUSTOM_COLOR, c.length === 6 ? c + 'FF' : c);
    }
  }

  function addOutlineSettings(x: 'primary' | 'ads') {
    if (s[x][PrimaryMapping.OUTLINES] === false) {
      appendPrimarySetting(PrimaryMapping.OUTLINES, x);
    } else {
      if (
        s[x][PrimaryMapping.OUTLINE_THICKNESS] !==
        DEFAULT_SETTINGS[x][PrimaryMapping.OUTLINE_THICKNESS]
      ) {
        appendPrimarySetting(PrimaryMapping.OUTLINE_THICKNESS, x);
      }
      if (
        s[x][PrimaryMapping.OUTLINE_OPACITY] !==
        DEFAULT_SETTINGS[x][PrimaryMapping.OUTLINE_OPACITY]
      ) {
        appendPrimarySetting(PrimaryMapping.OUTLINE_OPACITY, x);
      }
    }
  }

  function addCenterDotSettings(x: 'primary' | 'ads') {
    if (s[x][PrimaryMapping.CENTER_DOT] === true) {
      appendPrimarySetting(PrimaryMapping.CENTER_DOT, x);
      if (
        s[x][PrimaryMapping.CENTER_DOT_THICKNESS] !==
        DEFAULT_SETTINGS[x][PrimaryMapping.CENTER_DOT_THICKNESS]
      ) {
        appendPrimarySetting(PrimaryMapping.CENTER_DOT_THICKNESS, x);
      }
      if (
        s[x][PrimaryMapping.CENTER_DOT_OPACITY] !==
        DEFAULT_SETTINGS[x][PrimaryMapping.CENTER_DOT_OPACITY]
      ) {
        appendPrimarySetting(PrimaryMapping.CENTER_DOT_OPACITY, x);
      }
    }
  }

  function appendPrimarySetting(key: PrimaryMapping, x: 'primary' | 'ads' = 'primary') {
    const v = s[x][key];
    const value = typeof v === 'boolean' ? +v : v;
    appendSetting(key, value);
  }

  function appendSetting(key: string, value: any) {
    code += `${key};${value};`;
  }

  if (withName) {
    code += 'NAME;"' + s.name + '"';
  }

  if (code.endsWith(';')) {
    code = code.slice(0, -1);
  }

  return code;
}

// ---------------------------------------------------------------------------
// SVG String Generation (pure, no React)
// ---------------------------------------------------------------------------

export interface SVGGeneratorOptions {
  /** SVG canvas width in pixels (default: 200) */
  width?: number;
  /** SVG canvas height in pixels (default: 200) */
  height?: number;
  /** Scale multiplier for the crosshair (default: 1.3) */
  scale?: number;
  /** Optional background color (default: none/transparent) */
  backgroundColor?: string;
}

export function generateSVGString(
  settings: PrimarySettings,
  options: SVGGeneratorOptions = {}
): string {
  const { width = 200, height = 200, scale = 1.3, backgroundColor } = options;
  const crosshairColor = '#' + (settings[PrimaryMapping.CUSTOM_COLOR] ?? 'FFFFFF');
  const strokeWidth = settings[PrimaryMapping.OUTLINE_THICKNESS];
  const outlineOpacity = settings[PrimaryMapping.OUTLINE_OPACITY];
  const showOutlines = settings[PrimaryMapping.OUTLINES];

  function calculateGap(offset: number, firingError: boolean, override: boolean): number {
    const FIXED_GAP = 4;
    let result = 0;
    if (firingError && !override) result = FIXED_GAP;
    return result + offset;
  }

  const innerGap = calculateGap(
    settings.inner_lines[LineMapping.OFFSET],
    settings.inner_lines[LineMapping.FIRING_ERROR],
    settings[PrimaryMapping.OVERRIDE_FIRING_ERROR_OFFSET_WITH_CROSSHAIR_OFFSET]
  );
  const outerGap = calculateGap(
    settings.outer_lines[LineMapping.OFFSET],
    settings.outer_lines[LineMapping.FIRING_ERROR],
    settings[PrimaryMapping.OVERRIDE_FIRING_ERROR_OFFSET_WITH_CROSSHAIR_OFFSET]
  );

  const innerVLen = settings.inner_lines[LineMapping.LENGTH];
  const innerHLen = settings.inner_lines[LineMapping.LENGTH_NOT_LINKED]
    ? settings.inner_lines[LineMapping.VERTICAL]
    : innerVLen;
  const outerVLen = settings.outer_lines[LineMapping.LENGTH];
  const outerHLen = settings.outer_lines[LineMapping.LENGTH_NOT_LINKED]
    ? settings.outer_lines[LineMapping.VERTICAL]
    : outerVLen;

  function rectStr(
    x: number, y: number, w: number, h: number,
    sw: number, opacity: number, sOp: number, stroke: boolean
  ): string {
    let s = '';
    if (stroke && sw > 0) {
      s += `<rect x="${x - sw}" y="${y - sw}" width="${sw}" height="${h + sw * 2}" fill="black" opacity="${sOp}"/>`;
      s += `<rect x="${x + w}" y="${y - sw}" width="${sw}" height="${h + sw * 2}" fill="black" opacity="${sOp}"/>`;
      s += `<rect x="${x}" y="${y - sw}" width="${w}" height="${sw}" fill="black" opacity="${sOp}"/>`;
      s += `<rect x="${x}" y="${y + h}" width="${w}" height="${sw}" fill="black" opacity="${sOp}"/>`;
    }
    s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${crosshairColor}" opacity="${opacity}"/>`;
    return s;
  }

  const cx = width / 2;
  const cy = height / 2;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
  if (backgroundColor) svg += `<rect width="${width}" height="${height}" fill="${backgroundColor}"/>`;
  svg += `<g transform="translate(${cx}, ${cy}) scale(${scale})">`;

  if (settings[PrimaryMapping.CENTER_DOT]) {
    const ds = settings[PrimaryMapping.CENTER_DOT_THICKNESS];
    const dOff = ds / 2;
    svg += rectStr(-dOff, -dOff, ds, ds, strokeWidth, settings[PrimaryMapping.CENTER_DOT_OPACITY], outlineOpacity, showOutlines);
  }

  if (settings.inner_lines[LineMapping.SHOW] && settings.inner_lines[LineMapping.THICKNESS] > 0) {
    const t = settings.inner_lines[LineMapping.THICKNESS];
    const op = settings.inner_lines[LineMapping.OPACITY];
    const hy = -(t / 2);
    const hx = -(t / 2);
    if (innerVLen > 0) {
      svg += rectStr(-innerGap - innerVLen, hy, innerVLen, t, strokeWidth, op, outlineOpacity, showOutlines);
      svg += rectStr(innerGap, hy, innerVLen, t, strokeWidth, op, outlineOpacity, showOutlines);
    }
    if (innerHLen > 0) {
      svg += rectStr(hx, -innerGap - innerHLen, t, innerHLen, strokeWidth, op, outlineOpacity, showOutlines);
      svg += rectStr(hx, innerGap, t, innerHLen, strokeWidth, op, outlineOpacity, showOutlines);
    }
  }

  if (settings.outer_lines[LineMapping.SHOW] && settings.outer_lines[LineMapping.THICKNESS] > 0) {
    const t = settings.outer_lines[LineMapping.THICKNESS];
    const op = settings.outer_lines[LineMapping.OPACITY];
    const hy = -(t / 2);
    const hx = -(t / 2);
    if (outerVLen > 0) {
      svg += rectStr(-outerGap - outerVLen, hy, outerVLen, t, strokeWidth, op, outlineOpacity, showOutlines);
      svg += rectStr(outerGap, hy, outerVLen, t, strokeWidth, op, outlineOpacity, showOutlines);
    }
    if (outerHLen > 0) {
      svg += rectStr(hx, -outerGap - outerHLen, t, outerHLen, strokeWidth, op, outlineOpacity, showOutlines);
      svg += rectStr(hx, outerGap, t, outerHLen, strokeWidth, op, outlineOpacity, showOutlines);
    }
  }

  svg += '</g></svg>';
  return svg;
}

export function generateSVGFromCode(code: string, options: SVGGeneratorOptions = {}): string {
  return generateSVGString(generateCrosshairFromCode(code).primary, options);
}

export function svgToDataURI(svgString: string): string {
  return 'data:image/svg+xml;base64,' + btoa(svgString);
}

export function svgToEncodedDataURI(svgString: string): string {
  return 'data:image/svg+xml,' + encodeURIComponent(svgString);
}

// ===========================================================================
// REACT COMPONENTS
// ===========================================================================

// ---------------------------------------------------------------------------
// Internal: RectWithStroke component
// ---------------------------------------------------------------------------

interface RectWithStrokeProps {
  x: number;
  y: number;
  width: number;
  height: number;
  strokeWidth: number;
  opacity?: number;
  strokeOpacity?: number;
  name?: string;
  stroke?: boolean;
  fill: string;
}

function RectWithStroke({
  x,
  y,
  width,
  height,
  strokeWidth,
  opacity,
  strokeOpacity,
  name,
  stroke = true,
  fill,
}: RectWithStrokeProps) {
  return (
    <g data-name={name}>
      {stroke && strokeWidth > 0 ? (
        <g opacity={strokeOpacity}>
          <rect
            x={x - strokeWidth}
            y={y - strokeWidth}
            width={strokeWidth}
            height={height + strokeWidth * 2}
            fill="black"
          />
          <rect
            x={x + width}
            y={y - strokeWidth}
            width={strokeWidth}
            height={height + strokeWidth * 2}
            fill="black"
          />
          <rect
            x={x}
            y={y - strokeWidth}
            height={strokeWidth}
            width={width}
            fill="black"
          />
          <rect
            x={x}
            y={y + height}
            height={strokeWidth}
            width={width}
            fill="black"
          />
        </g>
      ) : null}
      <rect x={x} y={y} width={width} height={height} fill={fill} opacity={opacity} />
    </g>
  );
}

// ---------------------------------------------------------------------------
// Internal: geometry calculator hook
// ---------------------------------------------------------------------------

function useCrosshairGeometry(settings: PrimarySettings) {
  return useMemo(() => {
    const crosshairColor = '#' + (settings[PrimaryMapping.CUSTOM_COLOR] ?? 'FFFFFF');
    const strokeWidth = settings[PrimaryMapping.OUTLINE_THICKNESS];

    function calculateGap(offset: number, firingError: boolean, override: boolean): number {
      const FIXED_GAP = 4;
      let result = 0;
      if (firingError && !override) result = FIXED_GAP;
      return result + offset;
    }

    const innerGap = calculateGap(
      settings.inner_lines[LineMapping.OFFSET],
      settings.inner_lines[LineMapping.FIRING_ERROR],
      settings[PrimaryMapping.OVERRIDE_FIRING_ERROR_OFFSET_WITH_CROSSHAIR_OFFSET]
    );
    const outerGap = calculateGap(
      settings.outer_lines[LineMapping.OFFSET],
      settings.outer_lines[LineMapping.FIRING_ERROR],
      settings[PrimaryMapping.OVERRIDE_FIRING_ERROR_OFFSET_WITH_CROSSHAIR_OFFSET]
    );

    const innerVLen = settings.inner_lines[LineMapping.LENGTH];
    const innerHLen = settings.inner_lines[LineMapping.LENGTH_NOT_LINKED]
      ? settings.inner_lines[LineMapping.VERTICAL]
      : innerVLen;
    const outerVLen = settings.outer_lines[LineMapping.LENGTH];
    const outerHLen = settings.outer_lines[LineMapping.LENGTH_NOT_LINKED]
      ? settings.outer_lines[LineMapping.VERTICAL]
      : outerVLen;

    const innerVertY = -(settings.inner_lines[LineMapping.THICKNESS] / 2);
    const outerVertY = -(settings.outer_lines[LineMapping.THICKNESS] / 2);

    return {
      crosshairColor,
      strokeWidth,
      innerGap,
      outerGap,
      innerVLen,
      innerHLen,
      outerVLen,
      outerHLen,
      innerLineLeftX: -innerGap - settings.inner_lines[LineMapping.LENGTH],
      innerLineLeftY: innerVertY,
      innerLineRightX: innerGap,
      innerLineRightY: innerVertY,
      innerLineTopY: -innerGap - innerHLen,
      innerLineBottomY: innerGap,
      innerLineHorizontalX: -(settings.inner_lines[LineMapping.THICKNESS] / 2),
      outerLineLeftX: -outerGap - settings.outer_lines[LineMapping.LENGTH],
      outerLineLeftY: outerVertY,
      outerLineRightX: outerGap,
      outerLineRightY: outerVertY,
      outerLineTopY: -outerGap - outerHLen,
      outerLineBottomY: outerGap,
      outerLineHorizontalX: -(settings.outer_lines[LineMapping.THICKNESS] / 2),
      centerDotOffset: settings[PrimaryMapping.CENTER_DOT_THICKNESS] / 2,
    };
  }, [settings]);
}

// ---------------------------------------------------------------------------
// CrosshairSVG — React SVG component from PrimarySettings
// ---------------------------------------------------------------------------

export interface CrosshairSVGProps {
  /** The primary (or ADS) crosshair settings */
  settings: PrimarySettings;
  /** SVG width (default: 200) */
  width?: number;
  /** SVG height (default: 200) */
  height?: number;
  /** Scale multiplier (default: 1.3) */
  scale?: number;
  /** Background color (default: transparent) */
  backgroundColor?: string;
  /** Extra className on the <svg> element */
  className?: string;
  /** Extra inline style on the <svg> element */
  style?: React.CSSProperties;
}

export function CrosshairSVG({
  settings,
  width = 200,
  height = 200,
  scale = 1.3,
  backgroundColor,
  className,
  style,
}: CrosshairSVGProps) {
  const g = useCrosshairGeometry(settings);
  const showOutlines = settings[PrimaryMapping.OUTLINES];
  const outlineOpacity = settings[PrimaryMapping.OUTLINE_OPACITY];

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      style={style}
    >
      {backgroundColor && (
        <rect width={width} height={height} fill={backgroundColor} />
      )}

      <g transform={`translate(${width / 2}, ${height / 2}) scale(${scale})`}>
        {/* Center dot */}
        {settings[PrimaryMapping.CENTER_DOT] && (
          <RectWithStroke
            x={-g.centerDotOffset}
            y={-g.centerDotOffset}
            width={settings[PrimaryMapping.CENTER_DOT_THICKNESS]}
            height={settings[PrimaryMapping.CENTER_DOT_THICKNESS]}
            strokeWidth={g.strokeWidth}
            opacity={settings[PrimaryMapping.CENTER_DOT_OPACITY]}
            strokeOpacity={outlineOpacity}
            name="center-dot"
            stroke={showOutlines}
            fill={g.crosshairColor}
          />
        )}

        {/* Inner lines */}
        {settings.inner_lines[LineMapping.SHOW] &&
          settings.inner_lines[LineMapping.THICKNESS] > 0 && (
            <g data-name="inner-lines">
              {g.innerVLen > 0 && (
                <>
                  <RectWithStroke
                    x={g.innerLineLeftX}
                    y={g.innerLineLeftY}
                    width={g.innerVLen}
                    height={settings.inner_lines[LineMapping.THICKNESS]}
                    strokeWidth={g.strokeWidth}
                    opacity={settings.inner_lines[LineMapping.OPACITY]}
                    strokeOpacity={outlineOpacity}
                    name="inner-line-left"
                    stroke={showOutlines}
                    fill={g.crosshairColor}
                  />
                  <RectWithStroke
                    x={g.innerLineRightX}
                    y={g.innerLineRightY}
                    width={g.innerVLen}
                    height={settings.inner_lines[LineMapping.THICKNESS]}
                    strokeWidth={g.strokeWidth}
                    opacity={settings.inner_lines[LineMapping.OPACITY]}
                    strokeOpacity={outlineOpacity}
                    name="inner-line-right"
                    stroke={showOutlines}
                    fill={g.crosshairColor}
                  />
                </>
              )}
              {g.innerHLen > 0 && (
                <>
                  <RectWithStroke
                    x={g.innerLineHorizontalX}
                    y={g.innerLineTopY}
                    width={settings.inner_lines[LineMapping.THICKNESS]}
                    height={g.innerHLen}
                    strokeWidth={g.strokeWidth}
                    opacity={settings.inner_lines[LineMapping.OPACITY]}
                    strokeOpacity={outlineOpacity}
                    name="inner-line-top"
                    stroke={showOutlines}
                    fill={g.crosshairColor}
                  />
                  <RectWithStroke
                    x={g.innerLineHorizontalX}
                    y={g.innerLineBottomY}
                    width={settings.inner_lines[LineMapping.THICKNESS]}
                    height={g.innerHLen}
                    strokeWidth={g.strokeWidth}
                    opacity={settings.inner_lines[LineMapping.OPACITY]}
                    strokeOpacity={outlineOpacity}
                    name="inner-line-bottom"
                    stroke={showOutlines}
                    fill={g.crosshairColor}
                  />
                </>
              )}
            </g>
          )}

        {/* Outer lines */}
        {settings.outer_lines[LineMapping.SHOW] &&
          settings.outer_lines[LineMapping.THICKNESS] > 0 && (
            <g data-name="outer-lines">
              {g.outerVLen > 0 && (
                <>
                  <RectWithStroke
                    x={g.outerLineLeftX}
                    y={g.outerLineLeftY}
                    width={g.outerVLen}
                    height={settings.outer_lines[LineMapping.THICKNESS]}
                    strokeWidth={g.strokeWidth}
                    opacity={settings.outer_lines[LineMapping.OPACITY]}
                    strokeOpacity={outlineOpacity}
                    name="outer-line-left"
                    stroke={showOutlines}
                    fill={g.crosshairColor}
                  />
                  <RectWithStroke
                    x={g.outerLineRightX}
                    y={g.outerLineRightY}
                    width={g.outerVLen}
                    height={settings.outer_lines[LineMapping.THICKNESS]}
                    strokeWidth={g.strokeWidth}
                    opacity={settings.outer_lines[LineMapping.OPACITY]}
                    strokeOpacity={outlineOpacity}
                    name="outer-line-right"
                    stroke={showOutlines}
                    fill={g.crosshairColor}
                  />
                </>
              )}
              {g.outerHLen > 0 && (
                <>
                  <RectWithStroke
                    x={g.outerLineHorizontalX}
                    y={g.outerLineTopY}
                    width={settings.outer_lines[LineMapping.THICKNESS]}
                    height={g.outerHLen}
                    strokeWidth={g.strokeWidth}
                    opacity={settings.outer_lines[LineMapping.OPACITY]}
                    strokeOpacity={outlineOpacity}
                    name="outer-line-top"
                    stroke={showOutlines}
                    fill={g.crosshairColor}
                  />
                  <RectWithStroke
                    x={g.outerLineHorizontalX}
                    y={g.outerLineBottomY}
                    width={settings.outer_lines[LineMapping.THICKNESS]}
                    height={g.outerHLen}
                    strokeWidth={g.strokeWidth}
                    opacity={settings.outer_lines[LineMapping.OPACITY]}
                    strokeOpacity={outlineOpacity}
                    name="outer-line-bottom"
                    stroke={showOutlines}
                    fill={g.crosshairColor}
                  />
                </>
              )}
            </g>
          )}
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// SniperCrosshairSVG — React SVG component for sniper center dot
// ---------------------------------------------------------------------------

export interface SniperCrosshairSVGProps {
  settings: SniperSettings;
  width?: number;
  height?: number;
  backgroundColor?: string;
  className?: string;
  style?: React.CSSProperties;
}

export function SniperCrosshairSVG({
  settings,
  width = 200,
  height = 200,
  backgroundColor,
  className,
  style,
}: SniperCrosshairSVGProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      style={style}
    >
      {backgroundColor && (
        <rect width={width} height={height} fill={backgroundColor} />
      )}
      {settings[SniperCenterDotMapping.SHOW] && (
        <circle
          cx={width / 2}
          cy={height / 2}
          r={settings[SniperCenterDotMapping.THICKNESS] * 4}
          fill={'#' + settings[SniperCenterDotMapping.CUSTOM_COLOR]}
          opacity={settings[SniperCenterDotMapping.OPACITY]}
        />
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// CrosshairFromCode — convenience component: code string → rendered SVG
// ---------------------------------------------------------------------------

export interface CrosshairFromCodeProps {
  /** Valorant crosshair code string */
  code: string;
  /** Which view to render */
  view?: 'primary' | 'ads' | 'sniper';
  width?: number;
  height?: number;
  scale?: number;
  backgroundColor?: string;
  className?: string;
  style?: React.CSSProperties;
}

export function CrosshairFromCode({
  code,
  view = 'primary',
  width = 200,
  height = 200,
  scale = 1.3,
  backgroundColor,
  className,
  style,
}: CrosshairFromCodeProps) {
  const settings = useMemo(() => generateCrosshairFromCode(code), [code]);

  if (view === 'sniper') {
    return (
      <SniperCrosshairSVG
        settings={settings.sniper}
        width={width}
        height={height}
        backgroundColor={backgroundColor}
        className={className}
        style={style}
      />
    );
  }

  const primarySettings =
    view === 'ads' && !settings.ads_copy_primary ? settings.ads : settings.primary;

  return (
    <CrosshairSVG
      settings={primarySettings}
      width={width}
      height={height}
      scale={scale}
      backgroundColor={backgroundColor}
      className={className}
      style={style}
    />
  );
}

// ---------------------------------------------------------------------------
// useCrosshairSettings — hook to parse a crosshair code (memoized)
// ---------------------------------------------------------------------------

/**
 * React hook that parses a Valorant crosshair code string into CrosshairSettings.
 * Memoized — only re-parses when the code string changes.
 */
export function useCrosshairSettings(code: string): CrosshairSettings {
  return useMemo(() => generateCrosshairFromCode(code), [code]);
}
