#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
BUILD_DIR="${PROJECT_DIR}/build"
RUNTIME_DIR="${BUILD_DIR}/mac-runtime"
PYINSTALLER_ENV="${BUILD_DIR}/pyinstaller-env"
BUILD_PYTHON="${MY_SCHOLAR_BUILD_PYTHON:-/opt/anaconda3/bin/python3}"
ODL_JAR="${MY_SCHOLAR_ODL_JAR:-}"
if [[ -z "${ODL_JAR}" ]]; then
  ODL_JAR="$(zsh "${SCRIPT_DIR}/fetch-opendataloader.sh")"
fi
EXPECTED_ODL_SHA256="${MY_SCHOLAR_ODL_SHA256:-104a5523c812ba3a43a3c7dd6156e33f23d0e32f03ef1ac629009ef96d7a79e1}"
JAVA_HOME_PATH="${MY_SCHOLAR_JAVA_HOME:-$(/usr/libexec/java_home)}"
CA_BUNDLE_NAME="ca-certificates.crt"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  print -u2 "首版构建仅支持 Apple Silicon macOS。"
  exit 1
fi
if [[ ! -x "${BUILD_PYTHON}" ]]; then
  print -u2 "找不到用于构建独立服务的 Python：${BUILD_PYTHON}"
  exit 1
fi
if ! CERTIFI_CA="$("${BUILD_PYTHON}" -c 'import certifi; print(certifi.where())' 2>/dev/null)" || [[ ! -s "${CERTIFI_CA}" ]]; then
  print -u2 "构建 Python 缺少可用的 certifi CA bundle：${BUILD_PYTHON}"
  exit 1
fi
if [[ ! -f "${ODL_JAR}" ]]; then
  print -u2 "找不到 OpenDataLoader 转换组件：${ODL_JAR}"
  exit 1
fi
ACTUAL_ODL_SHA256="$(shasum -a 256 "${ODL_JAR}" | awk '{print $1}')"
if [[ "${ACTUAL_ODL_SHA256}" != "${EXPECTED_ODL_SHA256}" ]]; then
  print -u2 "OpenDataLoader 组件校验失败：${ACTUAL_ODL_SHA256}"
  exit 1
fi
if [[ ! -x "${JAVA_HOME_PATH}/bin/jlink" ]]; then
  print -u2 "找不到可用的 arm64 JDK：${JAVA_HOME_PATH}"
  exit 1
fi

mkdir -p "${BUILD_DIR}" "${RUNTIME_DIR}"
if [[ ! -x "${PYINSTALLER_ENV}/bin/python3" ]]; then
  "${BUILD_PYTHON}" -m venv "${PYINSTALLER_ENV}"
fi
if ! "${PYINSTALLER_ENV}/bin/python3" -c 'import PyInstaller' >/dev/null 2>&1; then
  "${PYINSTALLER_ENV}/bin/python3" -m pip install --disable-pip-version-check \
    'altgraph==0.17.5' \
    'macholib==1.16.4' \
    'packaging==26.3' \
    'pyinstaller-hooks-contrib==2026.6' \
    'setuptools==83.0.0' \
    'pyinstaller==6.16.0'
fi

"${PYINSTALLER_ENV}/bin/python3" -m PyInstaller \
  --clean \
  --noconfirm \
  --onedir \
  --name my-scholar-server \
  --distpath "${RUNTIME_DIR}" \
  --workpath "${BUILD_DIR}/pyinstaller-work" \
  --specpath "${BUILD_DIR}" \
  "${PROJECT_DIR}/server.py"

cp "${CERTIFI_CA}" "${RUNTIME_DIR}/my-scholar-server/${CA_BUNDLE_NAME}"
cp "${ODL_JAR}" "${RUNTIME_DIR}/opendataloader-pdf-cli-0.0.0.jar"
mkdir -p "${RUNTIME_DIR}/pdf-renderer"
"${JAVA_HOME_PATH}/bin/javac" \
  -cp "${ODL_JAR}" \
  -d "${RUNTIME_DIR}/pdf-renderer" \
  "${SCRIPT_DIR}/MyScholarPdfRenderer.java"
if [[ ! -x "${RUNTIME_DIR}/java/bin/java" ]]; then
  "${JAVA_HOME_PATH}/bin/jlink" \
    --add-modules java.base,java.compiler,java.desktop,java.management,java.sql \
    --strip-debug \
    --no-header-files \
    --no-man-pages \
    --compress=zip-6 \
    --output "${RUNTIME_DIR}/java"
fi

"${RUNTIME_DIR}/my-scholar-server/my-scholar-server" --help >/dev/null
"${RUNTIME_DIR}/java/bin/java" -version >/dev/null 2>&1
test -s "${RUNTIME_DIR}/my-scholar-server/${CA_BUNDLE_NAME}"
test -f "${RUNTIME_DIR}/pdf-renderer/MyScholarPdfRenderer.class"
print "macOS 独立运行时已准备完成：${RUNTIME_DIR}"
