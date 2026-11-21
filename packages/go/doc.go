// Package tronrunner is the Go SDK for connecting a worker to Tron's runner channel.
//
// A Runner authenticates with a worker API key, announces the handler keys it can execute,
// accepts each delivery Tron pushes the moment it arrives, persists the one-time delivery
// secret, runs the registered handler and reports exactly one Ok or Err outcome. The
// connection is re-established with exponential backoff when it drops.
//
// Every protocol message is a type from the generated package
// (github.com/umbra-yurei/tron-runner-sdk/packages/go/generated), produced from Tron's
// published AsyncAPI document; this package contains no hand-written JSON shape. Every
// refusal Tron can send surfaces as a value of that package's closed enums inside the
// typed errors defined here.
//
//	runner, err := tronrunner.New(tronrunner.Config{BaseURL: "https://tron.example.com", Token: token})
//	if err != nil { ... }
//	runner.Handle("backup", func(ctx context.Context, d tronrunner.Delivery) tronrunner.Outcome {
//		if err := backup(ctx); err != nil {
//			return tronrunner.Err(err.Error())
//		}
//		return tronrunner.Ok("backed up")
//	})
//	if err := runner.Connect(ctx); err != nil { ... } // *ConnectError when the first attempt fails
//	...
//	err = runner.Stop(ctx) // drains in-flight work, then closes
package tronrunner
