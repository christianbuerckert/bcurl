class Bcurl < Formula
  desc "Like curl, but returns a browser-rendered screenshot instead of source code"
  homepage "https://github.com/christianbuerckert/bcurl"
  url "https://github.com/christianbuerckert/bcurl/archive/refs/tags/v2.0.0.tar.gz"
  sha256 "664b76aae81049881366c441646b888caf7b1fcecf2f05a10c02f12287f84212"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    cd "#{libexec}/lib/node_modules/bcurl" do
      system "npm", "run", "build"
    end
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
