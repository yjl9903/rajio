#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/download-nico.sh [options] <niconico-url>

Downloads a niconico video with yt-dlp to:
  .rajio/<video title>/<video title>.<ext>

For encrypted niconico HLS streams, the script passes ffmpeg:
  -allowed_extensions ALL
  -extension_picky 0

Options:
  --cookies <file>                 Use an exported cookies.txt file.
  --cookies-from-browser <browser> Use browser cookies, e.g. chrome, firefox, safari.
  -o, --output-template <template> Override yt-dlp output template.
  -f, --format <format>            Override yt-dlp format selector.
  --                              Pass following args directly to yt-dlp.
  -h, --help                       Show this help.

Examples:
  scripts/download-nico.sh --cookies-from-browser chrome \
    https://www.nicovideo.jp/watch/so46390977

  scripts/download-nico.sh --cookies ./nico-cookies.txt \
    https://www.nicovideo.jp/watch/so46390977
EOF
}

url=""
cookies_file=""
cookies_browser=""
output_template=".rajio/%(title)s/%(title)s.%(ext)s"
format_selector="bv*+ba/b"
downloader_args=(
  --downloader-args "ffmpeg_i:-allowed_extensions ALL"
  --downloader-args "ffmpeg_i:-extension_picky 0"
)
extra_args=()

while (($#)); do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --cookies)
      [[ $# -ge 2 ]] || { echo "error: --cookies requires a file path" >&2; exit 2; }
      cookies_file="$2"
      shift 2
      ;;
    --cookies-from-browser)
      [[ $# -ge 2 ]] || { echo "error: --cookies-from-browser requires a browser name" >&2; exit 2; }
      cookies_browser="$2"
      shift 2
      ;;
    -o|--output-template)
      [[ $# -ge 2 ]] || { echo "error: $1 requires a template" >&2; exit 2; }
      output_template="$2"
      shift 2
      ;;
    -f|--format)
      [[ $# -ge 2 ]] || { echo "error: $1 requires a format selector" >&2; exit 2; }
      format_selector="$2"
      shift 2
      ;;
    --)
      shift
      extra_args+=("$@")
      break
      ;;
    http://*|https://*)
      if [[ -n "$url" ]]; then
        echo "error: only one URL is supported" >&2
        exit 2
      fi
      url="$1"
      shift
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      echo >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$url" ]]; then
  usage >&2
  exit 2
fi

if [[ -n "$cookies_file" && -n "$cookies_browser" ]]; then
  echo "error: use only one of --cookies or --cookies-from-browser" >&2
  exit 2
fi

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "error: yt-dlp is not installed or not in PATH" >&2
  exit 127
fi

auth_args=()
if [[ -n "$cookies_file" ]]; then
  if [[ ! -f "$cookies_file" ]]; then
    echo "error: cookies file does not exist: $cookies_file" >&2
    exit 2
  fi
  auth_args+=(--cookies "$cookies_file")
elif [[ -n "$cookies_browser" ]]; then
  auth_args+=(--cookies-from-browser "$cookies_browser")
fi

yt-dlp \
  --no-playlist \
  -f "$format_selector" \
  -o "$output_template" \
  "${downloader_args[@]}" \
  ${auth_args[@]+"${auth_args[@]}"} \
  ${extra_args[@]+"${extra_args[@]}"} \
  "$url"
