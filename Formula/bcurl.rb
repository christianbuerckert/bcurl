class Bcurl < Formula
  desc "Like curl, but returns a browser-rendered screenshot instead of source code"
  homepage "https://github.com/christianbuerckert/bcurl"
  url "https://github.com/christianbuerckert/bcurl/archive/refs/tags/v2.1.0.tar.gz"
  sha256 "9c872708b64acc81c51fddfda3bd133d10969ea36cc6978acdd699aa48d27b5a"
  license "MIT"

  depends_on "node"

  def install
    # Build TypeScript (requires devDependencies for tsc)
    system "npm", "install"
    system "npx", "tsc"
    # Install built package into libexec (production only)
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def post_install
    ohai "Installing Chromium for Playwright..."
    system "npx", "playwright", "install", "chromium"
  end

  test do
    assert_match "2.1.0", shell_output("#{bin}/bcurl --version").strip
  end
end
