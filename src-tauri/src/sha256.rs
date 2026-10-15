//! SHA-256, with no dependency.
//!
//! Why this file exists at all. `fetch.rs` refuses to install a payload it has
//! not checked, and checking means a digest over up to a gigabyte of bytes. The
//! obvious answer is the `sha2` crate; this crate's rule — written down at the
//! head of `backend.rs` — is that no dependency is added for something that can
//! be done here, and a digest is a far better fit for that rule than most
//! things. The algorithm is fixed, published as FIPS 180-4, and has official
//! test vectors, so a hand-written copy is checkable in a way that a hand-written
//! HTTP client never is: the four vectors below are NIST's own, and if this file
//! is ever wrong, one of them fails on the next `cargo test`.
//!
//! It is not a general-purpose cryptography module and does not pretend to be
//! one. It is not constant-time and it has no business hashing a secret — the
//! only thing it is ever handed is a file the app just downloaded, and the only
//! question asked of it is whether that file is the one the publisher signed
//! for.

use std::io::Read;
use std::path::Path;

/// The round constants: the first thirty-two bits of the fractional parts of the
/// cube roots of the first sixty-four primes. Spelled out rather than computed,
/// which is what the standard does and what every other implementation does.
const K: [u32; 64] = [
    0x428a_2f98,
    0x7137_4491,
    0xb5c0_fbcf,
    0xe9b5_dba5,
    0x3956_c25b,
    0x59f1_11f1,
    0x923f_82a4,
    0xab1c_5ed5,
    0xd807_aa98,
    0x1283_5b01,
    0x2431_85be,
    0x550c_7dc3,
    0x72be_5d74,
    0x80de_b1fe,
    0x9bdc_06a7,
    0xc19b_f174,
    0xe49b_69c1,
    0xefbe_4786,
    0x0fc1_9dc6,
    0x240c_a1cc,
    0x2de9_2c6f,
    0x4a74_84aa,
    0x5cb0_a9dc,
    0x76f9_88da,
    0x983e_5152,
    0xa831_c66d,
    0xb003_27c8,
    0xbf59_7fc7,
    0xc6e0_0bf3,
    0xd5a7_9147,
    0x06ca_6351,
    0x1429_2967,
    0x27b7_0a85,
    0x2e1b_2138,
    0x4d2c_6dfc,
    0x5338_0d13,
    0x650a_7354,
    0x766a_0abb,
    0x81c2_c92e,
    0x9272_2c85,
    0xa2bf_e8a1,
    0xa81a_664b,
    0xc24b_8b70,
    0xc76c_51a3,
    0xd192_e819,
    0xd699_0624,
    0xf40e_3585,
    0x106a_a070,
    0x19a4_c116,
    0x1e37_6c08,
    0x2748_774c,
    0x34b0_bcb5,
    0x391c_0cb3,
    0x4ed8_aa4a,
    0x5b9c_ca4f,
    0x682e_6ff3,
    0x748f_82ee,
    0x78a5_636f,
    0x84c8_7814,
    0x8cc7_0208,
    0x90be_fffa,
    0xa450_6ceb,
    0xbef9_a3f7,
    0xc671_78f2,
];

/// The initial state: the same construction over the square roots of the first
/// eight primes.
const H0: [u32; 8] = [
    0x6a09_e667,
    0xbb67_ae85,
    0x3c6e_f372,
    0xa54f_f53a,
    0x510e_527f,
    0x9b05_688c,
    0x1f83_d9ab,
    0x5be0_cd19,
];

/// One block, in bytes.
const BLOCK: usize = 64;

/// A digest under construction.
///
/// Streaming rather than whole-file because the largest payload this is ever
/// pointed at is Ollama, which is one and a half gigabytes: reading that into a
/// `Vec` to hash it would need the memory the download was meant to avoid, and
/// would fail on exactly the machines the app is for.
#[derive(Clone)]
pub struct Sha256 {
    state: [u32; 8],
    buffer: [u8; BLOCK],
    buffered: usize,
    /// Total length in *bits*, which is what the padding block carries.
    len_bits: u64,
}

impl Default for Sha256 {
    fn default() -> Self {
        Self::new()
    }
}

impl Sha256 {
    pub fn new() -> Self {
        Sha256 {
            state: H0,
            buffer: [0u8; BLOCK],
            buffered: 0,
            len_bits: 0,
        }
    }

    /// Add bytes. Any length, any number of times.
    pub fn update(&mut self, mut data: &[u8]) {
        self.len_bits = self.len_bits.wrapping_add((data.len() as u64) * 8);

        // Top up a partly-filled block first, so that the bulk loop below can
        // assume it is starting on a boundary.
        if self.buffered > 0 {
            let take = (BLOCK - self.buffered).min(data.len());
            self.buffer[self.buffered..self.buffered + take].copy_from_slice(&data[..take]);
            self.buffered += take;
            data = &data[take..];
            if self.buffered == BLOCK {
                let block = self.buffer;
                self.compress(&block);
                self.buffered = 0;
            }
        }

        // `as_chunks` rather than `chunks_exact` + `copy_from_slice`: it yields
        // `&[u8; BLOCK]` directly, so the compressor is handed the bytes in the
        // caller's buffer instead of a copy of them.
        let (blocks, rest) = data.as_chunks::<BLOCK>();
        for block in blocks {
            self.compress(block);
        }

        if !rest.is_empty() {
            self.buffer[..rest.len()].copy_from_slice(rest);
            self.buffered = rest.len();
        }
    }

    /// Finish, and hand back the thirty-two bytes.
    pub fn finish(mut self) -> [u8; 32] {
        // Captured before the padding is fed in, because the padding is not
        // message: the length that goes in the last block is the length of what
        // was actually hashed.
        let bits = self.len_bits;

        self.update(&[0x80]);
        // Pad with zeroes until the last eight bytes of a block are free. The
        // loop cannot spin: `update` keeps `buffered` inside `0..BLOCK`, so it
        // reaches fifty-six within sixty-four steps whatever it began at.
        while self.buffered != BLOCK - 8 {
            self.update(&[0]);
        }
        self.update(&bits.to_be_bytes());

        let mut out = [0u8; 32];
        for (i, word) in self.state.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        out
    }

    fn compress(&mut self, block: &[u8; BLOCK]) {
        let mut w = [0u32; 64];
        for (i, chunk) in block.as_chunks::<4>().0.iter().enumerate() {
            w[i] = u32::from_be_bytes(*chunk);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;

        for (i, word) in w.iter().enumerate() {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(*word);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);

            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }

        for (slot, value) in self.state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *slot = slot.wrapping_add(value);
        }
    }
}

/// The digest of a slice, which is what the tests below are written against.
///
/// Test-only on purpose. The app's one caller hashes a *file* — see
/// [`digest_file`] — and nothing on the shipping path ever holds a payload in
/// memory to hand it here, so this is the tests' convenience and is compiled
/// out of the binary rather than carried in it unused.
#[cfg(test)]
pub fn digest(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finish()
}

/// The digest of a file, read in chunks rather than whole.
pub fn digest_file(path: &Path) -> std::io::Result<[u8; 32]> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finish())
}

/// Lowercase hex, which is the spelling every published checksum file uses and
/// therefore the spelling the comparison is made in.
pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit((byte >> 4) as u32, 16).unwrap_or('0'));
        out.push(char::from_digit((byte & 0x0f) as u32, 16).unwrap_or('0'));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The vectors FIPS 180-4 publishes, plus the two the standard's own example
    /// set adds. The one-million-character case is the only one that is not a
    /// single block and a bit: it is 15,625 blocks, so it is the case that
    /// catches a buffering mistake rather than a compression mistake.
    #[test]
    fn the_published_vectors_all_hold() {
        assert_eq!(
            hex(&digest(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "the empty string",
        );
        assert_eq!(
            hex(&digest(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "abc",
        );
        assert_eq!(
            hex(&digest(
                b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
            )),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
            "the two-block message",
        );
        assert_eq!(
            hex(&digest(&vec![b'a'; 1_000_000])),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
            "a million a's",
        );
    }

    /// Splitting the input must not change the answer — which is the whole
    /// property a streaming hash has to have, and the one a bug in the
    /// partly-filled-block path would break while leaving every short vector
    /// above passing.
    #[test]
    fn how_the_bytes_are_chunked_does_not_matter() {
        let message: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
        let whole = hex(&digest(&message));

        for step in [1usize, 7, 63, 64, 65, 128, 333] {
            let mut hasher = Sha256::new();
            for chunk in message.chunks(step) {
                hasher.update(chunk);
            }
            assert_eq!(
                hex(&hasher.finish()),
                whole,
                "chunked in {step}s, the digest changed",
            );
        }
    }

    /// The file path, which is what the verifier actually calls, has to agree
    /// with the slice path — otherwise the check would pass in the test and mean
    /// nothing in the app.
    #[test]
    fn a_file_hashes_the_same_as_its_bytes() {
        let path = std::env::temp_dir().join("common-sha256-file-check");
        let body = b"the bytes on disk, hashed both ways";
        std::fs::write(&path, body).expect("write the scratch file");

        assert_eq!(
            hex(&digest_file(&path).expect("hash it")),
            hex(&digest(body))
        );

        let _ = std::fs::remove_file(&path);
    }
}
