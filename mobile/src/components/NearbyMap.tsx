import React, { useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { Platform, View } from 'react-native';
import { useTheme } from '../theme';
import { statusStyle } from '../lib/format';
import type { IssueType, NearbyItem } from '../lib/types';

export interface NearbyMapHandle {
  recenter(): void;
  zoom(by: 1 | -1): void;
}

// Emoji render natively in the WebView and read at a glance, unlike same-looking dots.
const GLYPH: Record<IssueType, string> = {
  pothole: '🚧',
  streetlight: '💡',
  garbage: '🗑️',
  water_leakage: '💧',
  drainage: '🕳️',
  other: '📍',
};

/**
 * Leaflet map in a WebView: OpenStreetMap tiles, no API key needed (react-native-maps would need a
 * paid Google Maps key for Android builds). Each pin shows the issue type and is ringed in its status
 * colour; tapping one calls onSelect(id). The first load zooms to fit you and every pin.
 */
export function NearbyMap({
  ref,
  center,
  radiusM,
  items,
  selectedId,
  onSelect,
}: {
  ref?: React.Ref<NearbyMapHandle>;
  center: { latitude: number; longitude: number };
  radiusM: number;
  items: NearbyItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { c, dark } = useTheme();
  const web = useRef<any>(null);
  const loaded = useRef(false);
  const run = (js: string) => loaded.current && web.current?.injectJavaScript(`${js};true;`);

  useImperativeHandle(ref, () => ({
    recenter: () => run('window.recenter()'),
    zoom: (by) => run(by > 0 ? 'map.zoomIn()' : 'map.zoomOut()'),
  }));

  const pins = useMemo(
    () =>
      items.map((i) => ({
        id: i.id,
        lat: i.latitude,
        lng: i.longitude,
        color: statusStyle(i.status, c).fg,
        glyph: GLYPH[i.issue_type ?? 'other'],
        count: i.supporters_count > 0 ? i.supporters_count + 1 : 0,
        mine: i.is_mine,
      })),
    [items, c],
  );
  const payload = JSON.stringify({ pins, selected: selectedId });

  const html = useMemo(
    () => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#m{margin:0;height:100%;background:${dark ? '#0B1220' : '#EEF2F6'}}
.leaflet-control-attribution{font-size:9px}
${dark ? '.leaflet-tile-pane{filter:invert(1) hue-rotate(180deg) brightness(.9) contrast(.9)}' : ''}
.pin{position:relative;width:40px;height:40px;border-radius:50%;background:#fff;border:3px solid;box-sizing:border-box;
  display:flex;align-items:center;justify-content:center;font-size:19px;box-shadow:0 2px 6px rgba(0,0,0,.35);transition:transform .15s}
.pin.mine{box-shadow:0 0 0 3px #111827,0 2px 6px rgba(0,0,0,.35)}
.pin.sel{transform:scale(1.3);z-index:1000}
.pin .n{position:absolute;top:-7px;right:-9px;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:#111827;
  color:#fff;font:700 11px/18px sans-serif;text-align:center;box-sizing:border-box}
.me{width:18px;height:18px;border-radius:50%;background:#2563EB;border:3px solid #fff;box-sizing:border-box;
  box-shadow:0 0 0 6px rgba(37,99,235,.25)}
</style></head>
<body><div id="m"></div><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>
var me=[${center.latitude},${center.longitude}];
var map=L.map('m',{zoomControl:false,attributionControl:true}).setView(me,15);
// OpenStreetMap tiles (no API key). If they fail to load, switch once to Esri's street map.
var osm=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
var errors=0,switched=false;
osm.on('tileerror',function(){if(switched||++errors<3)return;switched=true;map.removeLayer(osm);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,attribution:'Tiles &copy; Esri &mdash; OpenStreetMap'}).addTo(map);});
L.circle(me,{radius:${radiusM},color:'#0F766E',weight:1,opacity:.5,fillOpacity:.04,interactive:false}).addTo(map);
L.marker(me,{icon:L.divIcon({className:'',html:'<div class="me"></div>',iconSize:[18,18],iconAnchor:[9,9]}),interactive:false,zIndexOffset:-100}).addTo(map);
var layer=L.layerGroup().addTo(map),fitted=false,last=[];
window.recenter=function(){map.flyTo(me,15,{duration:.5})};
window.render=function(d){layer.clearLayers();last=d.pins;d.pins.forEach(function(p){
  var sel=p.id===d.selected;
  var html='<div class="pin'+(p.mine?' mine':'')+(sel?' sel':'')+'" style="border-color:'+p.color+'">'+p.glyph+(p.count?'<span class="n">'+p.count+'</span>':'')+'</div>';
  var m=L.marker([p.lat,p.lng],{icon:L.divIcon({className:'',html:html,iconSize:[40,40],iconAnchor:[20,20]}),zIndexOffset:sel?1000:0});
  m.on('click',function(){window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(p.id)});m.addTo(layer);
  if(sel)map.panTo([p.lat,p.lng],{animate:true});});
  if(!fitted&&d.pins.length){fitted=true;
    map.fitBounds(L.latLngBounds(d.pins.map(function(p){return[p.lat,p.lng]}).concat([me])),{padding:[48,48],maxZoom:16});}
};
</script></body></html>`,
    // Rebuild only when the centre or theme changes; pins are pushed with injectJavaScript.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [center.latitude, center.longitude, dark, radiusM],
  );

  useEffect(() => {
    run(`window.render(${payload})`);
  }, [payload]); // eslint-disable-line react-hooks/exhaustive-deps

  if (Platform.OS === 'web') {
    return <View style={{ flex: 1 }} />;
  }
  const { WebView } = require('react-native-webview') as typeof import('react-native-webview');
  return (
    <View style={{ flex: 1, backgroundColor: c.surfaceAlt }}>
      <WebView
        ref={web}
        originWhitelist={['*']}
        source={{ html, baseUrl: 'https://nagrik.app/' }}
        onLoadEnd={() => {
          loaded.current = true;
          run(`window.render(${payload})`);
        }}
        onMessage={(e) => onSelect(e.nativeEvent.data)}
        javaScriptEnabled
        nestedScrollEnabled
        setSupportMultipleWindows={false}
        style={{ backgroundColor: 'transparent' }}
      />
    </View>
  );
}
