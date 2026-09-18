class Gait < Formula
  desc "Finds the exact AI-agent edit that broke your tests"
  homepage "https://github.com/rohan-murmu/gait"
  url "https://github.com/rohan-murmu/gait/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "REPLACE_ON_RELEASE"
  license "MIT"
  head "https://github.com/rohan-murmu/gait.git", branch: "main"

  depends_on "git"
  depends_on "node"

  def install
    # The published tarball ships sources, not dist/, so build before packing.
    # `npm install --global` alone would run `prepare` without devDependencies
    # and the TypeScript build would fail for want of @types/node.
    system "npm", "ci"
    system "npm", "run", "build"
    system "npm", "install", *std_npm_args, "--ignore-scripts"
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/gait --version")

    # gait requires git to already exist, and reports an empty chain cleanly.
    (testpath/"repo").mkpath
    system "git", "-C", testpath/"repo", "init", "-q"
    output = shell_output("cd #{testpath}/repo && #{bin}/gait status")
    assert_match "checkpoints  0", output

    # A checkpoint must not appear on any branch.
    (testpath/"repo/a.txt").write "hello"
    system "git", "-C", testpath/"repo", "add", "-A"
    system "git", "-C", testpath/"repo", "-c", "user.email=t@t", "-c", "user.name=t",
           "commit", "-qm", "initial"
    (testpath/"repo/a.txt").write "changed"
    system bin/"gait", "checkpoint", "-m", "test", *["--quiet"], chdir: testpath/"repo"
    refs = shell_output("git -C #{testpath}/repo for-each-ref --format='%(refname)' refs/gait")
    assert_match "refs/gait/checkpoints/", refs
  end
end
