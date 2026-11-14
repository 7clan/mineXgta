#!/bin/bash
# Pull CC0 photographic texture/material files (Poly Haven) into the game as RAW assets.
# Files land in public/textures/raw/<slot>_<map>.jpg  (1K JPG: webgl-friendly size)
# Slots map 1:1 to engine material slots (textures.ts RAW registry keys).
set -uo pipefail

OUT="public/textures/raw"
API="https://api.polyhaven.com"
mkdir -p "$OUT"

# slot|asset_id|maps   (maps: d=diffuse, n=normal-opengl, r=roughness)
WANT=(
  "asphalt|asphalt_01|d,n,r"
  "sidewalk|concrete_pavement_02|d,n"
  "facade_stucco|clay_plaster|d,n"
  "facade_white|white_plaster_02|d,n"
  "facade_brick|brick_wall_02|d,n"
  "facade_concrete|concrete_panels|d,n"
  "facade_metal|corrugated_iron|d,n"
  "roof|concrete_layers|d,n"
  "grass|grass_ground|d,n"
  "strata_dirt|dirt|d,n"
  "strata_stone|cliff_side|d,n"
  "hills|brown_mud_dry|d,n"
  "trunk|bark_brown_01|d,n"
  "npc_shirt|cotton_jersey|d"
  "npc_pants|denim_fabric|d"
  "npc_jacket|fabric_leather_01|d"
  "npc_dress|fabric_pattern_05|d"
  "npc_shoe|brown_leather|d"
)

norm_key() { # echo the JSON key under which normals live for this asset
  curl -s --max-time 20 "$API/files/$1" | jq -r 'keys[] | select(startswith("Normal"))' | head -1
}

total=0; ok=0; fail=0
for entry in "${WANT[@]}"; do
  slot="${entry%%|*}"; rest="${entry#*|}"; asset="${rest%%|*}"; maps="${rest#*|}"
  json=$(curl -s --max-time 20 "$API/files/$asset")
  [ -z "$json" ] && { echo "[$slot] API MISS ($asset)"; fail=$((fail+1)); continue; }
  nkey=$(echo "$json" | jq -r 'keys[] | select(startswith("Normal"))' | head -1)
  IFS=',' read -ra M <<< "$maps"
  for m in "${M[@]}"; do
    case "$m" in
      d) jkey="Diffuse"; suffix="diff" ;;
      n) jkey="nor_gl";   suffix="nor"  ;;
      r) jkey="Rough";    suffix="rough" ;;
    esac
    dest="$OUT/${slot}_${suffix}.jpg"
    if [ -s "$dest" ] && file "$dest" | grep -q JPEG; then echo "[$slot/$suffix] cached"; continue; fi
    url=$(echo "$json" | jq -r --arg k "$jkey" '.[$k]["1k"]["jpg"]["url"] // empty' 2>/dev/null)
    if [ -z "$url" ] || [ "$url" = "null" ]; then
      url=$(echo "$json" | jq -r --arg k "$jkey" '.[$k]["2k"]["jpg"]["url"] // empty' 2>/dev/null)
      [ -n "$url" ] && [ "$url" != "null" ] && echo "[$slot/$suffix] using 2k (no 1k)"
    fi
    if [ -z "$url" ] || [ "$url" = "null" ]; then echo "[$slot/$suffix] no 1k jpg ($jkey)"; continue; fi
    code=$(curl -sL --max-time 90 -o "$dest" -w "%{http_code}" "$url")
    sz=$(stat -c%s "$dest" 2>/dev/null || echo 0)
    if [ "$code" = "200" ] && [ "$sz" -gt 50000 ] && file "$dest" | grep -q JPEG; then
      echo "[$slot/$suffix] OK ${sz}B  $asset"; ok=$((ok+1))
    else
      echo "[$slot/$suffix] FAIL http=$code size=$sz"; rm -f "$dest"; fail=$((fail+1))
    fi
    total=$((total+1))
  done
done
echo "---- done: ok=$ok fail=$fail files=$(ls $OUT | wc -l) bytes=$(du -sh $OUT | cut -f1)"
