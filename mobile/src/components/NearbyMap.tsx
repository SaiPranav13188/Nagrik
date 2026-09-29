import React, { useEffect, useMemo, useRef } from 'react';
import { Platform, View } from 'react-native';
import { useTheme } from '../theme';
import { statusStyle } from '../lib/format';
import type { NearbyItem } from '../lib/types';

/**
 * Leaflet map in a WebView: OpenStreetMap data with CARTO tiles, no API key needed (react-native-maps
 * would need a paid Google Maps key for Android builds). Pins are coloured by status; tapping one
 * calls onSelect(id).
 */
export function NearbyMap({
  center,
  items,
  onSelect,
  height,
}: {
  center: { latitude: number; longitude: number };
  items: NearbyItem[];
  onSelect: (id: string) => void;
  height: number;
}) {
  const { c, dark } = useTheme();
  const ref = useRef<any>(null);
  const loaded = useRef(false);

  const pins = useMemo(
    () => items.map((i) => ({ id: i.id, lat: i.latitude, lng: i.longitude, color: statusStyle(i.status, c).fg, big: i.supporters_count > 0, mine: i.is_mine })),
    [items, c],
  );

  const html = useMemo(
    () => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#m{margin:0;height:100%;background:${dark ? '#0B1220' : '#EEF2F6'}}.leaflet-control-attribution{font-size:9px}</style></head>
<body><div id="m"></div><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><script>
var map=L.map('m',{zoomControl:false,attributionControl:true}).setView([${center.latitude},${center.longitude}],15);
L.tileLayer('https://{s}.basemaps.cartocdn.com/${dark ? 'dark_all' : 'rastertiles/voyager'}/{z}/{x}/{y}{r}.png',{maxZoom:19,subdomains:'abcd',attribution:'&copy; OpenStreetMap &copy; CARTO'}).addTo(map);
L.circleMarker([${center.latitude},${center.longitude}],{radius:8,color:'#fff',weight:3,fillColor:'#2563EB',fillOpacity:1}).addTo(map);
var layer=L.layerGroup().addTo(map);
window.render=function(pins){layer.clearLayers();pins.forEach(function(p){
  var m=L.circleMarker([p.lat,p.lng],{radius:p.big?11:8,color:p.mine?'#111827':'#fff',weight:p.mine?3:2,fillColor:p.color,fillOpacity:.95});
  m.on('click',function(){window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(p.id)});m.addTo(layer);});};
window.render(${JSON.stringify(pins)});
</script></body></html>`,
    // Rebuild only when the centre or theme changes; pins are pushed with injectJavaScript.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [center.latitude, center.longitude, dark],
  );

  useEffect(() => {
    if (loaded.current) ref.current?.injectJavaScript(`window.render(${JSON.stringify(pins)});true;`);
  }, [pins]);

  if (Platform.OS === 'web') {
    return <View style={{ height: 0 }} />;
  }
  const { WebView } = require('react-native-webview') as typeof import('react-native-webview');
  return (
    <View style={{ height, backgroundColor: c.surfaceAlt }}>
      <WebView
        ref={ref}
        originWhitelist={['*']}
        source={{ html, baseUrl: 'https://nagrik.app/' }}
        onLoadEnd={() => {
          loaded.current = true;
          ref.current?.injectJavaScript(`window.render(${JSON.stringify(pins)});true;`);
        }}
        onMessage={(e) => onSelect(e.nativeEvent.data)}
        javaScriptEnabled
        scrollEnabled={false}
        setSupportMultipleWindows={false}
        style={{ backgroundColor: 'transparent' }}
      />
    </View>
  );
}
