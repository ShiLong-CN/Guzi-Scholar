#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
VERSION="${MY_SCHOLAR_ODL_VERSION:-2.5.1}"
ZIP_SHA256="${MY_SCHOLAR_ODL_ZIP_SHA256:-01bd864a20ac92ea9ee44dc97d5520cfd4f6e08760187c8f756b192186dccd73}"
JAR_SHA256="${MY_SCHOLAR_ODL_SHA256:-104a5523c812ba3a43a3c7dd6156e33f23d0e32f03ef1ac629009ef96d7a79e1}"
OUTPUT_DIR="${MY_SCHOLAR_ODL_OUTPUT_DIR:-${PROJECT_DIR}/build/toolchain}"
ZIP_PATH="${OUTPUT_DIR}/opendataloader-pdf-cli-${VERSION}.zip"
JAR_PATH="${OUTPUT_DIR}/opendataloader-pdf-cli-${VERSION}.jar"
LICENSE_DIR="${OUTPUT_DIR}/licenses/opendataloader-pdf"
DOWNLOAD_URL="${MY_SCHOLAR_ODL_DOWNLOAD_URL:-https://github.com/opendataloader-project/opendataloader-pdf/releases/download/v${VERSION}/opendataloader-pdf-cli-${VERSION}.zip}"

mkdir -p "${OUTPUT_DIR}"
if [[ ! -f "${ZIP_PATH}" ]]; then
  curl --fail --silent --show-error --location --retry 3 --max-time 180 \
    --output "${ZIP_PATH}.download" "${DOWNLOAD_URL}"
  mv "${ZIP_PATH}.download" "${ZIP_PATH}"
fi
printf '%s  %s\n' "${ZIP_SHA256}" "${ZIP_PATH}" | shasum --algorithm 256 --check --status

if [[ ! -f "${JAR_PATH}" ]]; then
  temporary="${JAR_PATH}.tmp.$$"
  unzip -p "${ZIP_PATH}" "opendataloader-pdf-cli-${VERSION}.jar" >"${temporary}"
  mv "${temporary}" "${JAR_PATH}"
fi
printf '%s  %s\n' "${JAR_SHA256}" "${JAR_PATH}" | shasum --algorithm 256 --check --status
mkdir -p "${LICENSE_DIR}"
unzip -oq "${ZIP_PATH}" LICENSE NOTICE README.md 'THIRD_PARTY/*' -d "${LICENSE_DIR}"
print -r -- "${JAR_PATH}"
