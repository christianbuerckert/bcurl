class Bcurl < Formula
  desc "Like curl, but returns a browser-rendered screenshot instead of source code"
  homepage "https://github.com/christianbuerckert/bcurl"
  url "https://github.com/christianbuerckert/bcurl/archive/refs/tags/v2.3.0.tar.gz"
  sha256 "dba96ccc4fc6cc0646955eeb87e01184df7f1ddac2f2f2b2e790ed215e8e9232"
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
    assert_match "2.3.0", shell_output("#{bin}/bcurl --version").strip
  end
end
