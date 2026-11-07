#!/usr/bin/env bash
set -euo pipefail

# install-harness.sh
# 安装 / 同步 harness 配置文件到本地 agent 目录

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="pi"
MODE="symlink"
FORCE=false
DRY_RUN=false
TARGET_DIR=""

usage() {
  cat <<EOF
Usage: $(basename "$0") [options] [harness]

Arguments:
  harness                Target harness name (default: "pi")

Options:
  -m, --mode <mode>      Install mode: "symlink" (default) or "copy"
  -t, --target <path>    Custom target directory (default: ~/.pi/agent for pi)
  -f, --force            Overwrite existing files without prompting or backup
  -d, --dry-run          Preview changes without executing
  -h, --help             Show this help message

Examples:
  ./install-harness.sh                  # Link pi configuration to ~/.pi/agent
  ./install-harness.sh --dry-run        # Preview actions
  ./install-harness.sh -m copy          # Copy files instead of creating symlinks
EOF
}

# 解析命令行参数
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    -d|--dry-run)
      DRY_RUN=true
      shift
      ;;
    -f|--force)
      FORCE=true
      shift
      ;;
    -m|--mode)
      MODE="$2"
      shift 2
      ;;
    -t|--target)
      TARGET_DIR="$2"
      shift 2
      ;;
    -*)
      echo "Error: Unknown option $1" >&2
      usage
      exit 1
      ;;
    *)
      HARNESS="$1"
      shift
      ;;
  esac
done

HARNESS_DIR="${SCRIPT_DIR}/harnesses/${HARNESS}"

if [[ ! -d "${HARNESS_DIR}" ]]; then
  echo "Error: Harness '${HARNESS}' not found at ${HARNESS_DIR}" >&2
  exit 1
fi

# 确定默认目标目录
if [[ -z "${TARGET_DIR}" ]]; then
  case "${HARNESS}" in
    pi)
      TARGET_DIR="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
      ;;
    *)
      TARGET_DIR="${HOME}/.${HARNESS}"
      ;;
  esac
fi

echo "=================================================="
echo "Harness       : ${HARNESS}"
echo "Source        : ${HARNESS_DIR}"
echo "Target        : ${TARGET_DIR}"
echo "Install Mode  : ${MODE}"
echo "Dry Run       : ${DRY_RUN}"
echo "=================================================="

# 辅助函数：安全备份并部署单个文件
deploy_file() {
  local src="$1"
  local dest="$2"

  if [[ ! -e "${src}" ]]; then
    return 0
  fi

  # 检查是否已是正确的软链接
  if [[ -L "${dest}" ]]; then
    local current_target
    current_target="$(readlink "${dest}")"
    if [[ "${current_target}" == "${src}" ]]; then
      echo "  [OK] Already linked: ${dest} -> ${src}"
      return 0
    fi
  fi

  # 检查目标文件存在情况
  if [[ -e "${dest}" || -L "${dest}" ]]; then
    if [[ "${FORCE}" == false ]]; then
      local backup="${dest}.bak.$(date +%Y%m%d%H%M%S)"
      echo "  [BACKUP] ${dest} -> ${backup}"
      if [[ "${DRY_RUN}" == false ]]; then
        mv "${dest}" "${backup}"
      fi
    else
      echo "  [REMOVE] Overwriting existing ${dest}"
      if [[ "${DRY_RUN}" == false ]]; then
        rm -rf "${dest}"
      fi
    fi
  fi

  # 执行安装
  if [[ "${MODE}" == "symlink" ]]; then
    echo "  [LINK] ${dest} -> ${src}"
    if [[ "${DRY_RUN}" == false ]]; then
      ln -s "${src}" "${dest}"
    fi
  else
    echo "  [COPY] ${src} -> ${dest}"
    if [[ "${DRY_RUN}" == false ]]; then
      cp -a "${src}" "${dest}"
    fi
  fi
}

# 1. 确保目标目录存在
if [[ "${DRY_RUN}" == false ]]; then
  mkdir -p -m 700 "${TARGET_DIR}"
fi

# 2. 部署核心配置文件
echo ""
echo "Deploying configuration files..."
if [[ -d "${HARNESS_DIR}/config" ]]; then
  for file in "${HARNESS_DIR}/config"/*; do
    if [[ -f "${file}" ]]; then
      filename="$(basename "${file}")"
      deploy_file "${file}" "${TARGET_DIR}/${filename}"
    fi
  done
fi

# 3. 部署插件目录 (extensions)
echo ""
echo "Deploying extensions..."
if [[ -d "${HARNESS_DIR}/extensions" ]]; then
  TARGET_EXT_DIR="${TARGET_DIR}/extensions"
  if [[ "${DRY_RUN}" == false ]]; then
    mkdir -p "${TARGET_EXT_DIR}"
  fi

  has_ext=false
  for ext in "${HARNESS_DIR}/extensions"/*; do
    if [[ -e "${ext}" && "$(basename "${ext}")" != ".gitkeep" ]]; then
      has_ext=true
      ext_name="$(basename "${ext}")"
      deploy_file "${ext}" "${TARGET_EXT_DIR}/${ext_name}"
    fi
  done

  if [[ "${has_ext}" == false ]]; then
    echo "  (No custom extensions to deploy yet)"
  fi
fi

# 4. 部署插件独立配置 (plugin-configs)
echo ""
echo "Deploying plugin configs..."
if [[ -d "${HARNESS_DIR}/plugin-configs" ]]; then
  for pdir in "${HARNESS_DIR}/plugin-configs"/*; do
    if [[ -d "${pdir}" && -f "${pdir}/config.json" ]]; then
      pname="$(basename "${pdir}")"
      if [[ "${pname}" == "session-ui" || "${pname}" == "repo-cache-manager" ]]; then
        # 如果已纳管 extensions/${pname} 目录，在 symlink 模式下内部软链接自然生效；
        # 在 copy 模式下，需要将真实配置文件覆盖复制到目标插件目录中，防止相对软链接断裂
        if [[ -d "${HARNESS_DIR}/extensions/${pname}" ]]; then
          if [[ "${MODE}" == "copy" ]]; then
            deploy_file "${pdir}/config.json" "${TARGET_DIR}/extensions/${pname}/config.json"
          else
            echo "  [OK] ${pname} config is linked inside extensions/${pname}"
          fi
        else
          if [[ "${DRY_RUN}" == false ]]; then
            mkdir -p "${TARGET_DIR}/extensions/${pname}"
          fi
          deploy_file "${pdir}/config.json" "${TARGET_DIR}/extensions/${pname}/config.json"
        fi
        # 对于 repo-cache-manager，额外在根目录提供一份方便直接编辑的链接/副本
        if [[ "${pname}" == "repo-cache-manager" ]]; then
          deploy_file "${pdir}/config.json" "${TARGET_DIR}/${pname}.json"
        fi
      else
        deploy_file "${pdir}/config.json" "${TARGET_DIR}/${pname}.json"
      fi
    fi
  done
fi

# 5. 部署主题 (themes)
echo ""
echo "Deploying themes..."
if [[ -d "${HARNESS_DIR}/themes" ]]; then
  TARGET_THEME_DIR="${TARGET_DIR}/themes"
  if [[ "${DRY_RUN}" == false ]]; then
    mkdir -p "${TARGET_THEME_DIR}"
  fi
  for theme_file in "${HARNESS_DIR}/themes"/*; do
    if [[ -f "${theme_file}" ]]; then
      tname="$(basename "${theme_file}")"
      deploy_file "${theme_file}" "${TARGET_THEME_DIR}/${tname}"
    fi
  done
fi

# 6. 部署全局规则 (rules/AGENTS.md)
echo ""
echo "Deploying rules..."
RULES_FILE="${SCRIPT_DIR}/rules/AGENTS.md"
if [[ -f "${RULES_FILE}" ]]; then
  case "${HARNESS}" in
    claude-code|claude)
      deploy_file "${RULES_FILE}" "${TARGET_DIR}/CLAUDE.md"
      ;;
    *)
      deploy_file "${RULES_FILE}" "${TARGET_DIR}/AGENTS.md"
      ;;
  esac
fi

# 7. 检查 models.json 模板
if [[ -f "${HARNESS_DIR}/models.example.json" ]]; then
  if [[ ! -f "${TARGET_DIR}/models.json" ]]; then
    echo ""
    echo "[NOTE] ${TARGET_DIR}/models.json not found."
    echo "       You can copy the example template with:"
    echo "       cp ${HARNESS_DIR}/models.example.json ${TARGET_DIR}/models.json"
  fi
fi

echo ""
echo "Installation complete!"
