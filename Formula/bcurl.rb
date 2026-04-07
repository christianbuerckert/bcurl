class Bcurl < Formula
  desc "Like curl, but returns a browser-rendered screenshot instead of source code"
  homepage "https://github.com/christianbuerckert/bcurl"
  url "https://github.com/christianbuerckert/bcurl/archive/refs/tags/v2.4.0.tar.gz"
  sha256 "1791808dbcaf2449f953db8a6f392aa159b0ec8c2297771bf9f7c1bef7605418"
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
    assert_match "2.4.0", shell_output("#{bin}/bcurl --version").strip
  end
end
