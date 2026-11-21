// Writes a throwaway certificate authority and one server certificate it signed, as PEM files, into the directory given
// as the only argument: ca.pem, server.pem, server.key. The release run trusts ca.pem and serves server.pem; nothing here
// outlives the run. Standard library only, so it needs no module.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

func main() {
	if len(os.Args) != 2 {
		fail(fmt.Errorf("usage: go run mkcerts.go <output-directory>"))
	}
	directory := os.Args[1]
	now := time.Now()

	caKey := newKey()
	caTemplate := &x509.Certificate{
		SerialNumber:          serial(),
		Subject:               pkix.Name{CommonName: "tron-runner-sdk release run CA"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	check(err)
	caCertificate, err := x509.ParseCertificate(caDER)
	check(err)

	serverKey := newKey()
	serverTemplate := &x509.Certificate{
		SerialNumber:          serial(),
		Subject:               pkix.Name{CommonName: "localhost"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(24 * time.Hour),
		DNSNames:              []string{"localhost"},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	serverDER, err := x509.CreateCertificate(rand.Reader, serverTemplate, caCertificate, &serverKey.PublicKey, caKey)
	check(err)
	serverKeyDER, err := x509.MarshalPKCS8PrivateKey(serverKey)
	check(err)

	write(directory, "ca.pem", "CERTIFICATE", caDER, 0o644)
	write(directory, "server.pem", "CERTIFICATE", serverDER, 0o644)
	write(directory, "server.key", "PRIVATE KEY", serverKeyDER, 0o600)
}

func newKey() *ecdsa.PrivateKey {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	check(err)
	return key
}

func serial() *big.Int {
	number, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	check(err)
	return number
}

func write(directory, name, kind string, der []byte, mode os.FileMode) {
	check(os.WriteFile(filepath.Join(directory, name), pem.EncodeToMemory(&pem.Block{Type: kind, Bytes: der}), mode))
}

func check(err error) {
	if err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
