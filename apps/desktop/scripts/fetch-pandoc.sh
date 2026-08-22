#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
VERSION="${MY_SCHOLAR_PANDOC_VERSION:-3.10.2}"
ZIP_SHA256="${MY_SCHOLAR_PANDOC_ZIP_SHA256:-a30bd546062f0b29c25f45a71f951b7a1cf4f998d5b43974ea2c2416133f2e99}"
OUTPUT_DIR="${MY_SCHOLAR_PANDOC_OUTPUT_DIR:-${PROJECT_DIR}/build/toolchain}"
ZIP_NAME="pandoc-${VERSION}-arm64-macOS.zip"
ZIP_PATH="${OUTPUT_DIR}/${ZIP_NAME}"
PANDOC_DIR="${OUTPUT_DIR}/pandoc"
PANDOC_PATH="${PANDOC_DIR}/pandoc"
LICENSE_DIR="${OUTPUT_DIR}/licenses/pandoc"
LICENSE_PATH="${LICENSE_DIR}/COPYING.md"
DOWNLOAD_URL="${MY_SCHOLAR_PANDOC_DOWNLOAD_URL:-https://github.com/jgm/pandoc/releases/download/${VERSION}/${ZIP_NAME}}"
LICENSE_URL="${MY_SCHOLAR_PANDOC_LICENSE_URL:-https://raw.githubusercontent.com/jgm/pandoc/${VERSION}/COPYING.md}"

mkdir -p "${OUTPUT_DIR}"
if [[ ! -f "${ZIP_PATH}" ]]; then
  curl --fail --silent --show-error --location --retry 3 --max-time 300 \
    --output "${ZIP_PATH}.download" "${DOWNLOAD_URL}"
  mv "${ZIP_PATH}.download" "${ZIP_PATH}"
fi
printf '%s  %s\n' "${ZIP_SHA256}" "${ZIP_PATH}" | shasum --algorithm 256 --check --status

mkdir -p "${PANDOC_DIR}"
if [[ ! -x "${PANDOC_PATH}" ]] || ! "${PANDOC_PATH}" --version 2>/dev/null | grep -F "pandoc ${VERSION}" >/dev/null; then
  temporary="${PANDOC_PATH}.tmp.$$"
  unzip -p "${ZIP_PATH}" "pandoc-${VERSION}-arm64/bin/pandoc" >"${temporary}"
  chmod 755 "${temporary}"
  mv "${temporary}" "${PANDOC_PATH}"
fi
if [[ "$(file -b "${PANDOC_PATH}")" != *"Mach-O 64-bit executable arm64"* ]]; then
  print -u2 "Pandoc 不是 macOS arm64 可执行文件：${PANDOC_PATH}"
  exit 1
fi
"${PANDOC_PATH}" --version | grep -F "pandoc ${VERSION}" >/dev/null

mkdir -p "${LICENSE_DIR}"
if [[ ! -s "${LICENSE_PATH}" ]]; then
  curl --fail --silent --show-error --location --retry 3 --max-time 60 \
    --output "${LICENSE_PATH}.download" "${LICENSE_URL}"
  mv "${LICENSE_PATH}.download" "${LICENSE_PATH}"
fi
grep -F "GNU GENERAL PUBLIC LICENSE" "${LICENSE_PATH}" >/dev/null

print -r -- "${PANDOC_PATH}"
