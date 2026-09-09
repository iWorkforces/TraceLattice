#!/usr/bin/env bash
#
# install-tracelattice.sh
# Installation script for tracelattice as a global npm module
#

set -e  # Exit on error

# Colors for output
readonly RED=$'\033[0;31m'
readonly GREEN=$'\033[0;32m'
readonly YELLOW=$'\033[1;33m'
readonly BLUE=$'\033[0;34m'
readonly NC=$'\033[0m' # No Color

# Package info
readonly PACKAGE_NAME="tracelattice"

# Read version from package.json
_package_version=$(node -p "require('./package.json').version" 2>/dev/null)

# Fallback version if package.json is not available
if [ -z "$_package_version" ] || [ "$_package_version" = "undefined" ]; then
    _package_version="0.0.0"
fi
readonly PACKAGE_VERSION="$_package_version"

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_command() {
    if ! command -v "$1" &> /dev/null; then
        log_error "$1 is not installed or not in PATH"
        return 1
    fi
    return 0
}

check_node_version() {
    local node_version
    node_version=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
    if [ -z "$node_version" ]; then
        log_error "Could not determine Node.js version"
        return 1
    fi
    if [ "$node_version" -lt 18 ]; then
        log_error "Node.js version 18 or higher is required (current: v$node_version)"
        return 1
    fi
    log_success "Node.js version check passed (v$node_version)"
    return 0
}

print_banner() {
    cat << "EOF"

--- Semantic Sequential Thinking MCP Server - Global Installation ---

EOF
}

print_usage() {
    cat << EOF
Usage: $0 [OPTIONS]

Options:
    -h, --help              Show this help message
    -v, --verbose           Enable verbose output
    --skip-deps-check       Skip Node.js/npm version checks
    --link                  Use npm link instead of global install (development mode)

Examples:
    $0                      # Standard installation
    $0 --verbose            # Verbose installation
    $0 --link               # Development mode (npm link)

EOF
}

cleanup() {
    local exit_code=$?
    if [ $exit_code -ne 0 ]; then
        log_error "Installation failed with exit code $exit_code"
    fi
}

parse_args() {
	local skip_deps_check=false
	local use_npm_link=false
	local verbose=false

	while [[ $# -gt 0 ]]; do
		case $1 in
			-h|--help)
				print_usage
				exit 0
				;;
			-v|--verbose)
				verbose=true
				set -x
				;;
			--skip-deps-check)
				skip_deps_check=true
				;;
			--link)
				use_npm_link=true
				;;
			*)
				log_error "Unknown option: $1"
				print_usage
				exit 1
				;;
		esac
		shift
	done

	echo "$skip_deps_check $use_npm_link $verbose"
}

check_prerequisites() {
	local skip_deps_check=$1

	log_info "Checking prerequisites..."

	if [ "$skip_deps_check" = false ]; then
		check_command "node" || exit 1
		check_command "npm" || exit 1
		check_node_version || exit 1
	else
		log_warn "Skipping dependency checks (--skip-deps-check)"
	fi

	# Verify we're in the correct directory
	if [ ! -f "package.json" ]; then
		log_error "package.json not found. Please run this script from the project root."
		exit 1
	fi

	if [ ! -f "tsconfig.json" ]; then
		log_error "tsconfig.json not found. Please run this script from the project root."
		exit 1
	fi

	log_success "Project directory verified"
}

build_project() {
	# Clean previous build
	log_info "Cleaning previous build..."
	if [ -d "dist" ]; then
		rm -rf dist
		log_success "Cleaned previous build"
	fi

	# Install dependencies
	log_info "Installing dependencies..."
	if ! npm install; then
		log_error "Failed to install dependencies"
		exit 1
	fi
	log_success "Dependencies installed"

	# Build the project
	log_info "Building project..."
	if ! npm run build; then
		log_error "Build failed"
		exit 1
	fi
	log_success "Build completed"

	# Verify the build output
	if [ ! -f "dist/lib.js" ]; then
		log_error "Build output dist/lib.js not found"
		exit 1
	fi

	if [ ! -x "dist/cli.js" ]; then
		log_warn "dist/cli.js is not executable, fixing..."
		chmod +x dist/cli.js
	fi

	log_success "Build output verified"
}

install_globally() {
	local use_npm_link=$1

	if [ "$use_npm_link" = true ]; then
		log_info "Using npm link for development..."
		if ! npm link; then
			log_error "npm link failed"
			log_warn "You may need to run this script with sudo privileges"
			exit 1
		fi
		log_success "Package linked globally"
	else
		log_info "Installing package globally..."
		local package_dir
		package_dir=$(pwd -P)
		if ! npm install -g "$package_dir"; then
			log_error "Global installation failed"
			log_warn "You may need to run this script with sudo privileges"
			exit 1
		fi
		log_success "Package installed globally"
	fi
}

verify_installation() {
	echo ""
	log_info "Verifying installation..."

	if command -v "$PACKAGE_NAME" &> /dev/null; then
		local installed_path
		installed_path=$(command -v "$PACKAGE_NAME")
		log_success "Package is available at: $installed_path"

		local npm_prefix
		npm_prefix=$(npm config get prefix)
		log_success "Global npm prefix: $npm_prefix"
	else
		log_warn "Package binary not found in PATH"
		log_info "You may need to add the npm global bin directory to your PATH"
		log_info "Run: npm config get prefix to see where npm installs global packages"
	fi

	# Print completion message
	echo ""
	log_success "Installation completed successfully!"
	echo ""
	cat << EOF
${GREEN}Next steps:${NC}

1. Verify the installation:
   ${YELLOW}$PACKAGE_NAME --help${NC}

2. To use this MCP server with Claude Desktop or another MCP client,
   add the following to your MCP client configuration:

   ${BLUE}{
     "mcpServers": {
       "sequentialthinking": {
         "command": "$PACKAGE_NAME"
       }
     }
   }${NC}

3. For development mode (if used --link):
   The package is linked. Changes to the source code will require
   rebuilding with ${YELLOW}npm run build${NC}

EOF
}

main() {
	local args
	args=$(parse_args "$@")
	local skip_deps_check=$(echo "$args" | cut -d' ' -f1)
	local use_npm_link=$(echo "$args" | cut -d' ' -f2)

	# Set up cleanup trap
	trap cleanup EXIT

	# Print banner
	print_banner

	log_info "Installing ${PACKAGE_NAME} v${PACKAGE_VERSION} globally..."
	echo ""

	check_prerequisites "$skip_deps_check"
	build_project
	install_globally "$use_npm_link"
	verify_installation
}

# Run main function
main "$@"
